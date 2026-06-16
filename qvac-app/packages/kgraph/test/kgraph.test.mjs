// kgraph over a real @qvac/factstore (relative import — no install needed). The pack here is
// a TOY, generic domain (things/tags) — that's the point: kgraph carries zero domain vocabulary,
// so passing these proves domain-neutrality structurally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFactStore } from "../../factstore/src/index.js";
import { createKnowledgeGraph, createSchema, seedSchema, loadSchema } from "../src/index.js";

const PACK = {
  log: "kg:toy",
  ontology: {
    kinds: [{ name: "thing" }, { name: "tag" }],
    predicates: [
      { name: "related_to", epistemics: "factual", valueType: "ref", symmetric: true, domain: ["thing"], range: ["thing"] },
      { name: "part_of", epistemics: "factual", valueType: "ref", symmetric: false, domain: ["thing"], range: ["thing"] },
      { name: "reminds_of", epistemics: "associative", valueType: "ref", symmetric: true }, // suggest-only
    ],
  },
  recipes: [{ id: "related", from: "x", via: ["related_to"], depth: 1 }],
};
const kgOf = () => createKnowledgeGraph(createFactStore(), { pack: PACK });

test("nodes: attributes + kind round-trip", async () => {
  const kg = kgOf();
  await kg.assertNode("thing:a", { attrs: { label: "Alpha" } });
  const n = await kg.getNode("thing:a");
  assert.equal(n.kind, "thing");
  assert.equal(n.attrs.label, "Alpha");
});

test("read-time symmetry: a symmetric edge written once is reachable both ways", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b" }); // ONE direction
  const fromA = (await kg.neighbors("thing:a")).map((e) => e.neighbor);
  const fromB = (await kg.neighbors("thing:b")).map((e) => e.neighbor);
  assert.ok(fromA.includes("thing:b"), "a → b");
  assert.ok(fromB.includes("thing:a"), "b → a (derived symmetry)");
});

test("directed edge: part_of goes outward only (not back)", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "part_of", to: "thing:b" });
  const fromA = (await kg.neighbors("thing:a")).map((e) => e.neighbor);
  const fromBout = (await kg.neighbors("thing:b", { dir: "out" })).map((e) => e.neighbor);
  const fromBin = (await kg.neighbors("thing:b", { dir: "in" })).map((e) => e.neighbor);
  assert.ok(fromA.includes("thing:b"));
  assert.ok(!fromBout.includes("thing:a"), "directed: b does not reach a outward");
  assert.ok(fromBin.includes("thing:a"), "but b←a is visible in-direction");
});

test("expand: depth-bounded neighbourhood", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b" });
  await kg.assertEdge({ from: "thing:b", predicate: "related_to", to: "thing:c" });
  const sub = await kg.expand("thing:a", { depth: 2, predicates: ["related_to"] });
  assert.ok(sub.nodes.includes("thing:b") && sub.nodes.includes("thing:c"));
});

test("paths: bounded, ranked by aggregate confidence (top path first)", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:d", confidence: 0.4 }); // 1-hop, weak
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:m", confidence: 0.9 });
  await kg.assertEdge({ from: "thing:m", predicate: "related_to", to: "thing:d", confidence: 0.9 }); // 2-hop, 0.81
  const paths = await kg.paths("thing:a", "thing:d", { maxHops: 2, predicates: ["related_to"], topK: 5 });
  assert.ok(paths.length >= 2);
  assert.equal(paths[0].hops, 2, "the 0.81 two-hop outranks the 0.4 one-hop");
  assert.ok(paths[0].confidence > paths[1].confidence);
});

test("grounding rule: factual predicates ground; associative ones throw", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b" });
  await kg.assertEdge({ from: "thing:a", predicate: "reminds_of", to: "thing:z" });

  const grounded = await kg.ground({ id: "rel", from: "x", via: ["related_to"], depth: 1 }, { x: "thing:a" });
  assert.ok(grounded.answer.includes("thing:b"));
  assert.ok(grounded.receipts.length >= 1, "grounding returns receipts");

  await assert.rejects(
    () => kg.ground({ id: "bad", from: "x", via: ["reminds_of"], depth: 1 }, { x: "thing:a" }),
    /cannot GROUND on 'reminds_of'/,
    "must refuse to ground on an associative edge",
  );
  // ...but suggest-mode is allowed
  const suggested = await kg.ground({ id: "sug", mode: "suggest", from: "x", via: ["reminds_of"], depth: 1 }, { x: "thing:a" });
  assert.ok(suggested.answer.includes("thing:z"));
});

test("forward-compatible validation: an unknown predicate is flagged, never dropped", async () => {
  const kg = kgOf();
  const res = await kg.assertEdge({ from: "thing:a", predicate: "newer_peer_predicate", to: "thing:b" });
  assert.ok(res.warnings.some((w) => /unschema'd/.test(w)), "unknown predicate is flagged");
  const edges = await kg.neighbors("thing:a", { predicates: ["newer_peer_predicate"] });
  assert.equal(edges.length, 1, "but the edge is still written + reachable");
});

test("schema-as-data: seed → load round-trips the ontology", async () => {
  const store = createFactStore();
  await seedSchema(store, "kg:schema", PACK.ontology);
  const schema = await loadSchema(store, "kg:schema");
  assert.deepEqual(schema.predicateNames().sort(), ["part_of", "related_to", "reminds_of"]);
  assert.equal(schema.isFactual("related_to"), true);
  assert.equal(schema.isAssociative("reminds_of"), true);
  assert.equal(schema.isSymmetric("part_of"), false);
  // and the loaded schema drives a working graph
  const kg = createKnowledgeGraph(store, { schema, log: "kg:toy2" });
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b" });
  assert.ok((await kg.neighbors("thing:b")).map((e) => e.neighbor).includes("thing:a"));
});

test("idempotent: re-asserting the same edge upserts (no duplicate)", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b", confidence: 0.5 });
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b", confidence: 0.9 }); // upsert
  const ns = await kg.neighbors("thing:a", { predicates: ["related_to"] });
  assert.equal(ns.length, 1, "one logical edge, not two");
  assert.equal(ns[0].confidence, 0.9, "latest assert wins");
});

test("symmetric edge isn't double-listed even if both directions are asserted", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b" });
  await kg.assertEdge({ from: "thing:b", predicate: "related_to", to: "thing:a" }); // redundant for symmetric
  const ns = await kg.neighbors("thing:a", { predicates: ["related_to"] });
  assert.equal(ns.filter((e) => e.neighbor === "thing:b").length, 1);
});

test("as-of (slice) read preserves confidence + meta", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b", confidence: 0.42, meta: { note: "x" } });
  const at = new Date().toISOString();
  const ns = await kg.neighbors("thing:a", { predicates: ["related_to"], slice: { knownAt: at } });
  assert.equal(ns.length, 1);
  assert.equal(ns[0].confidence, 0.42, "slice path carries confidence (not the old store.neighbors default of 1)");
  assert.equal(ns[0].meta.note, "x");
});

test("grounding excludes un-vetted (proposed) edges; raw neighbors still show them", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b" });                       // authored
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:c", meta: { proposed: true } }); // candidate

  const grounded = await kg.ground({ id: "rel", from: "x", via: ["related_to"], depth: 1 }, { x: "thing:a" });
  assert.ok(grounded.answer.includes("thing:b"), "authored edge grounds");
  assert.ok(!grounded.answer.includes("thing:c"), "un-vetted candidate must NOT ground a decision");

  const raw = (await kg.neighbors("thing:a")).map((e) => e.neighbor);
  assert.ok(raw.includes("thing:c"), "but a raw read still surfaces the candidate");
  const confirmed = (await kg.neighbors("thing:a", { confirmedOnly: true })).map((e) => e.neighbor);
  assert.ok(!confirmed.includes("thing:c"));
});

test("getNode.exists: declared nodes only", async () => {
  const kg = kgOf();
  await kg.assertNode("thing:a", { attrs: { label: "A" } });
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:ghost" }); // ghost never declared
  assert.equal((await kg.getNode("thing:a")).exists, true);
  assert.equal((await kg.getNode("thing:ghost")).exists, false, "an edge target alone isn't a declared node");
});

test("recipe registry: ground by id (from the pack)", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b" });
  assert.deepEqual(kg.recipeIds(), ["related"]);
  const r = await kg.ground("related", { x: "thing:a" });
  assert.ok(r.answer.includes("thing:b"));
  await assert.rejects(() => kg.ground("nope", { x: "thing:a" }), /unknown recipe/);
});

test("lifecycle: confirmEdge promotes a candidate so it grounds; retractEdge removes it", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:c", meta: { proposed: true } });
  assert.ok(!(await kg.ground("related", { x: "thing:a" })).answer.includes("thing:c"), "candidate doesn't ground");

  await kg.confirmEdge("thing:a", "related_to", "thing:c");          // promote
  assert.ok((await kg.ground("related", { x: "thing:a" })).answer.includes("thing:c"), "now it grounds");

  await kg.retractEdge("thing:a", "related_to", "thing:c", { reason: "wrong" });
  assert.ok(!(await kg.neighbors("thing:a")).some((e) => e.neighbor === "thing:c"), "retracted edge is gone");
});

test("pairsAmong: edges within a set (symmetric, deduped, confirmed-only)", async () => {
  const kg = kgOf();
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b" });        // a–b (in set)
  await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:out" });       // out of set
  await kg.assertEdge({ from: "thing:b", predicate: "related_to", to: "thing:c", meta: { proposed: 1 } }); // candidate (truthy, not literal true)
  const pairs = await kg.pairsAmong(["thing:a", "thing:b", "thing:c"], { predicates: ["related_to"] }); // confirmedOnly defaults true
  assert.equal(pairs.length, 1, "default is safe: only the confirmed a–b pair (truthy proposed excluded)");
  assert.equal([pairs[0].from, pairs[0].to].sort().join("|"), "thing:a|thing:b");
  const withCand = await kg.pairsAmong(["thing:a", "thing:b", "thing:c"], { predicates: ["related_to"], confirmedOnly: false });
  assert.equal(withCand.length, 2, "explicit raw read includes the b–c candidate");
});

test("neutrality smoke: createSchema accepts an arbitrary non-medical domain", () => {
  const incident = createSchema({
    kinds: [{ name: "svc" }, { name: "team" }],
    predicates: [{ name: "depends_on", epistemics: "factual", valueType: "ref", transitive: true }],
  });
  assert.equal(incident.isFactual("depends_on"), true);
});
