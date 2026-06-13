import { test } from "node:test";
import assert from "node:assert/strict";
import { FactStore, MemoryAdapter, makeFactstoreTools, createFactStore } from "../src/index.js";
import { exportOKF, importOKF } from "../src/okf.js";
import { sha256hex } from "../src/hash.js";

// A store with a controllable clock + deterministic ids, so we can drive transaction time.
function makeStore() {
  const clock = { t: "2026-01-01T00:00:00.000Z" };
  let n = 0;
  const store = new FactStore({
    adapter: new MemoryAdapter(), hash: sha256hex,
    now: () => clock.t, newId: () => `stmt-${++n}`,
  });
  return { store, clock };
}

test("assert → fold current state + receipt", async () => {
  const { store } = makeStore();
  await store.assert("patient:1", { statementId: "s1", subject: "patient:1", predicate: "takes",
    object: { name: "warfarin", dose: "5mg" }, validFrom: "2024-03-01", source: "intake", actor: "clinician" });
  const { facts, receipt } = await store.fold("patient:1", { subject: "patient:1", validAt: "2026-06-01T00:00:00.000Z", knownAt: "2026-06-01T00:00:00.000Z" });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].object.dose, "5mg");
  assert.equal(receipt.statements.length, 1);
  assert.equal(receipt.statements[0].statementId, "s1");
  assert.ok(receipt.statements[0].hash, "receipt pins the fact to a chain hash");
});

test("end closes the valid interval (history preserved)", async () => {
  const { store, clock } = makeStore();
  await store.assert("p", { statementId: "s1", subject: "p", predicate: "takes", object: { name: "warfarin" }, validFrom: "2026-01-01" });
  clock.t = "2026-03-10T00:00:00.000Z";
  await store.end("p", "s1", "2026-03-10");
  assert.equal((await store.fold("p", { subject: "p", validAt: "2026-02-01" })).facts.length, 1, "valid before the end date");
  assert.equal((await store.fold("p", { subject: "p", validAt: "2026-04-01" })).facts.length, 0, "gone after the end date");
  const tl = await store.timeline("p", { subject: "p" });
  assert.deepEqual(tl.map((x) => x.op), ["assert", "end"], "history keeps both ops");
});

test("BI-TEMPORAL: a correction is visible as-of transaction time, not retroactively", async () => {
  const { store, clock } = makeStore();
  clock.t = "2026-06-01T00:00:00.000Z";
  await store.assert("p", { statementId: "s1", subject: "p", predicate: "takes", object: { name: "warfarin", dose: "5mg" }, validFrom: "2024-01-01" });
  clock.t = "2026-06-20T00:00:00.000Z";
  await store.correct("p", "s1", { object: { name: "warfarin", dose: "2.5mg" } });

  // As KNOWN on June 10 (before the correction was recorded): still 5mg.
  let r = await store.fold("p", { subject: "p", validAt: "2026-06-15", knownAt: "2026-06-10T00:00:00.000Z" });
  assert.equal(r.facts[0].object.dose, "5mg", "as-known-at June 10 = the un-corrected value");
  // As KNOWN on June 25 (after the correction): 2.5mg.
  r = await store.fold("p", { subject: "p", validAt: "2026-06-15", knownAt: "2026-06-25T00:00:00.000Z" });
  assert.equal(r.facts[0].object.dose, "2.5mg", "as-known-at June 25 = the corrected value");
});

test("retract removes a fact asserted in error", async () => {
  const { store } = makeStore();
  await store.assert("p", { statementId: "s1", subject: "p", predicate: "x", object: 1 });
  await store.retract("p", "s1", { reason: "asserted in error" });
  assert.equal((await store.fold("p", { subject: "p" })).facts.length, 0);
});

test("reference object → one-hop neighbors (graph edge)", async () => {
  const { store } = makeStore();
  await store.assert("kb", { statementId: "e1", subject: "drug:warfarin", predicate: "interacts_with", object: { ref: "drug:ibuprofen" } });
  const edges = await store.neighbors("kb", "drug:warfarin", {});
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, "drug:ibuprofen");
});

test("verify detects tampering", async () => {
  const { store } = makeStore();
  await store.assert("p", { statementId: "s1", subject: "p", predicate: "x", object: 1 });
  await store.assert("p", { statementId: "s2", subject: "p", predicate: "y", object: 2 });
  assert.ok((await store.verify("p")).ok);
  // Tamper a stored record directly.
  const rec = JSON.parse(store.adapter.logs.get("p")[0]); rec.payload.object = 999;
  store.adapter.logs.get("p")[0] = JSON.stringify(rec);
  const v = await store.verify("p");
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 0);
});

test("export/import bundle with a (mock) device signature", async () => {
  const signer = { identity: () => ({ publicKey: "PUB", name: "kioskA" }), sign: (m) => "sig:" + m };
  const verify = (m, sig, pub) => sig === "sig:" + m && pub === "PUB";
  const a = new FactStore({ adapter: new MemoryAdapter(), hash: sha256hex, now: () => "2026-01-01T00:00:00.000Z", newId: () => "x", signer, verify });
  await a.assert("patient:9", { statementId: "s1", subject: "patient:9", predicate: "takes", object: { name: "warfarin" }, validFrom: "2024-01-01" });
  const bundle = await a.exportBundle("patient:9");
  assert.equal(bundle.format, "qvac-factlog");
  assert.ok(bundle.signature);

  // Import into a FRESH device → verifies + persists, facts queryable.
  const b = new FactStore({ adapter: new MemoryAdapter(), hash: sha256hex, now: () => "2026-12-01T00:00:00.000Z", newId: () => "x", verify });
  const res = await b.importBundle(bundle);
  assert.ok(res.ok && res.signatureOk && res.imported);
  assert.equal((await b.fold("patient:9", { subject: "patient:9", validAt: "2026-06-01" })).facts[0].object.name, "warfarin");

  // A tampered bundle is rejected (chain break) and not persisted.
  const evil = JSON.parse(JSON.stringify(bundle));
  evil.statements[0].payload.object = { name: "hacked" };
  const c = new FactStore({ adapter: new MemoryAdapter(), hash: sha256hex, now: () => "2026-12-01T00:00:00.000Z", newId: () => "x", verify });
  const res2 = await c.importBundle(evil);
  assert.equal(res2.ok, false);
  assert.equal(res2.imported, false);
});

test("agent tools: recall, propose-write gating", async () => {
  const { store } = makeStore();
  await store.assert("patient:1", { statementId: "s1", subject: "patient:1", predicate: "takes", object: { name: "warfarin" }, validFrom: "2024-01-01" });

  const tools = makeFactstoreTools(store, { log: "patient:1", allowWrite: "propose" });
  const recall = tools.find((t) => t.def.function.name === "recall");
  const out = await recall.run({ subject: "patient:1" });
  assert.equal(out.facts[0].object.name, "warfarin");
  assert.ok(out.receipt);

  const remember = tools.find((t) => t.def.function.name === "remember");
  const w = await remember.run({ subject: "patient:1", predicate: "reports", object: "headache", validFrom: "2026-06-01" });
  assert.ok(w.recorded.statementId);
  const proposed = (await store.fold("patient:1", { subject: "patient:1", predicate: "reports", validAt: "2026-07-01" })).facts[0];
  assert.equal(proposed.confidence, 0.5, "agent proposals are low-confidence");
  assert.equal(proposed.source, "agent");

  // read-only mode exposes no write tools
  const ro = makeFactstoreTools(store, { log: "patient:1", allowWrite: "none" });
  assert.equal(ro.find((t) => t.def.function.name === "remember"), undefined);
});

test("OKF interop: export reference log to OKF bundle, round-trip back", async () => {
  const a = createFactStore();
  await a.assert("kb:medical", { subject: "drug:warfarin", predicate: "type", object: "Drug" });
  await a.assert("kb:medical", { subject: "drug:warfarin", predicate: "title", object: "Warfarin" });
  await a.assert("kb:medical", { subject: "drug:warfarin", predicate: "interacts_with", object: { ref: "drug:ibuprofen" } });

  const files = await exportOKF(a, { log: "kb:medical" });
  assert.ok(files["drug/warfarin.md"], "one concept doc per subject");
  assert.match(files["drug/warfarin.md"], /type: Drug/, "typed attribute -> frontmatter");
  assert.match(files["drug/warfarin.md"], /drug\/ibuprofen\.md/, "ref edge -> markdown link");
  assert.ok(files["index.md"], "bundle index");

  // Round-trip into a fresh store (reference-knowledge interchange).
  const b = createFactStore();
  await importOKF(files, b, { log: "kb:imported" });
  const { facts } = await b.fold("kb:imported", { subject: "drug:warfarin" });
  const preds = facts.map((f) => f.predicate);
  assert.ok(preds.includes("type"), "frontmatter survives the round-trip");
  // OKF links are UNTYPED: interacts_with flattens to links_to (the documented lossiness).
  const edge = facts.find((f) => f.object && typeof f.object === "object" && f.object.ref);
  assert.equal(edge.predicate, "links_to");
  assert.equal(edge.object.ref, "drug:ibuprofen");
  assert.equal(edge.source, "okf");
});

test("OKF re-import is idempotent (no duplicate facts)", async () => {
  const a = createFactStore();
  await a.assert("kb", { subject: "drug:x", predicate: "type", object: "Drug" });
  const files = await exportOKF(a, { log: "kb" });
  const b = createFactStore();
  await importOKF(files, b, { log: "kbi" });
  await importOKF(files, b, { log: "kbi" }); // refresh from an updated bundle
  const { facts } = await b.fold("kbi", { subject: "drug:x" });
  assert.equal(facts.filter((f) => f.predicate === "type").length, 1, "type not duplicated on re-import");
});

test("end/correct/retract on a non-existent fact throws (no silent no-op)", async () => {
  const { store } = makeStore();
  await assert.rejects(() => store.end("p", "nope", "2026-01-01"), /no fact with statementId/);
  await assert.rejects(() => store.correct("p", "nope", { object: 1 }), /no fact with statementId/);
  await assert.rejects(() => store.retract("p", "nope", {}), /no fact with statementId/);
});

test("importBundle rejects an UNSIGNED bundle when a verifier is configured", async () => {
  const a = createFactStore(); // no signer -> unsigned bundle
  await a.assert("kb:x", { subject: "drug:x", predicate: "type", object: "Drug" });
  const bundle = await a.exportBundle("kb:x");
  assert.equal(bundle.signature, undefined);
  const b = new FactStore({ adapter: new MemoryAdapter(), hash: sha256hex, now: () => "2026-01-01T00:00:00.000Z", newId: () => "x", verify: () => true });
  const res = await b.importBundle(bundle);
  assert.equal(res.signatureOk, false, "a store expecting signatures distrusts an unsigned bundle");
  assert.equal(res.imported, false);
  const c = createFactStore();
  const res2 = await c.importBundle(bundle);
  assert.ok(res2.signatureOk && res2.imported, "a store not using signatures accepts it");
});

test("fold throws on an unparseable date (no silent empty result)", async () => {
  const { store } = makeStore();
  await store.assert("p", { statementId: "s1", subject: "p", predicate: "x", object: 1, validFrom: "2024-01-01" });
  await assert.rejects(() => store.fold("p", { subject: "p", validAt: "not-a-date" }), /invalid validAt/);
});

test("concurrent importBundle into one fresh log doesn't fork the chain", async () => {
  const a = createFactStore();
  await a.assert("kb:c", { subject: "x", predicate: "p", object: 1 });
  await a.assert("kb:c", { subject: "y", predicate: "q", object: 2 });
  const bundle = await a.exportBundle("kb:c");
  const b = createFactStore();
  const [r1, r2] = await Promise.all([b.importBundle(bundle), b.importBundle(bundle)]);
  assert.equal([r1.imported, r2.imported].filter(Boolean).length, 1, "exactly one import wins");
  assert.ok((await b.verify("kb:c")).ok, "chain intact, not forked");
});

test("trust: confirmed-only queries, confirm/reject lifecycle", async () => {
  const { store } = makeStore();
  // a confirmed clinician fact + an agent proposal
  await store.assert("p", { statementId: "c1", subject: "p", predicate: "takes", object: { name: "warfarin" }, source: "clinician" });
  await store.assert("p", { statementId: "a1", subject: "p", predicate: "reports", object: "headache", source: "agent", confidence: 0.5, meta: { proposed: true } });

  assert.equal((await store.fold("p", { status: "all" })).facts.length, 2);
  assert.equal((await store.fold("p", { status: "confirmed" })).facts.length, 1, "proposals excluded");
  assert.equal((await store.fold("p", { status: "proposed" })).facts[0].statementId, "a1");
  assert.equal((await store.fold("p", { minConfidence: 0.8 })).facts.length, 1);
  assert.equal((await store.fold("p", { sources: ["clinician"] })).facts.length, 1);

  // confirm promotes the proposal -> now in confirmed-only
  await store.confirm("p", "a1");
  const conf = await store.fold("p", { status: "confirmed" });
  assert.equal(conf.facts.length, 2, "confirmed proposal now authoritative");
  assert.equal(conf.facts.find((f) => f.statementId === "a1").confidence, 1);

  // reject retracts
  await store.reject("p", "a1");
  assert.equal((await store.fold("p", { status: "all" })).facts.length, 1, "rejected fact gone");
});

test("trust: source-ranked conflict resolution surfaces the loser", async () => {
  const { store, clock } = makeStore();
  await store.assert("p", { statementId: "intake1", subject: "p", predicate: "takes", object: { name: "warfarin", dose: "5mg" }, source: "intake" });
  clock.t = "2026-02-01T00:00:00.000Z";
  await store.assert("p", { statementId: "ehr1", subject: "p", predicate: "takes", object: { name: "warfarin", dose: "2.5mg" }, source: "ehr" });

  // Without resolution: both facts (a latent conflict).
  assert.equal((await store.fold("p", { subject: "p", predicate: "takes" })).facts.length, 2);
  // With source rank ehr > intake: EHR wins, intake surfaced as conflict.
  const r = await store.fold("p", { subject: "p", predicate: "takes", sourceRank: ["ehr", "clinician", "intake", "agent"] });
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].source, "ehr");
  assert.equal(r.facts[0].object.dose, "2.5mg");
  assert.equal(r.facts[0].conflict[0].source, "intake", "the overridden source is surfaced");
});

test("interaction-graph traversal: join patient meds against the kb interaction graph", async () => {
  const s = createFactStore();
  // authored kb:medical interaction graph (NOT LLM-extracted)
  await s.assert("kb:medical", { subject: "drug:warfarin", predicate: "interacts_with", object: { ref: "drug:ibuprofen" }, meta: { severity: "major" }, source: "authored" });
  // patient's current meds, as drug references
  await s.assert("patient:1", { subject: "patient:1", predicate: "takes", object: { ref: "drug:warfarin" }, source: "intake" });

  // "is it safe to add ibuprofen?" -> drug set = current meds + candidate
  const meds = (await s.fold("patient:1", { subject: "patient:1", predicate: "takes" })).facts.map((f) => f.object.ref);
  const edges = await s.edgesAmong("kb:medical", [...meds, "drug:ibuprofen"], { predicate: "interacts_with" });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].from, "drug:warfarin");
  assert.equal(edges[0].to, "drug:ibuprofen");
  assert.equal(edges[0].meta.severity, "major", "carries the authored severity");
  // no interaction when the candidate isn't in the graph
  assert.equal((await s.edgesAmong("kb:medical", [...meds, "drug:paracetamol"], { predicate: "interacts_with" })).length, 0);
});

test("multi-writer merge: foldView unions per-device sub-logs (CRDT, latest-tx-time wins)", async () => {
  const s = createFactStore();
  // Device A records the patient on warfarin Jan 1; Device B (offline, separate chain)
  // records a NEW condition AND a correction to the dose, later.
  await s.assert("patient:9@deviceA", { statementId: "med1", subject: "patient:9", predicate: "takes", object: { name: "warfarin", dose: "5mg" }, validFrom: "2024-01-01" });
  await s.assert("patient:9@deviceB", { statementId: "cond1", subject: "patient:9", predicate: "diagnosed", object: { name: "hypertension" }, validFrom: "2023-01-01" });
  // each sub-log verifies independently
  assert.ok((await s.verify("patient:9@deviceA")).ok);
  assert.ok((await s.verify("patient:9@deviceB")).ok);

  // The merged VIEW sees both devices' facts.
  const view = await s.foldView("patient:9", { subject: "patient:9", validAt: "2026-06-01" });
  assert.equal(view.facts.length, 2);
  assert.deepEqual(view.sublogs.sort(), ["patient:9@deviceA", "patient:9@deviceB"]);
  const preds = view.facts.map((f) => f.predicate).sort();
  assert.deepEqual(preds, ["diagnosed", "takes"]);
});

test("multi-writer merge: a correction on one device wins over the other by transaction time", async () => {
  const s = new FactStore({ adapter: new MemoryAdapter(), hash: sha256hex, now: () => clk.t, newId: () => "x" });
  const clk = { t: "2026-01-01T00:00:00.000Z" };
  // Device A asserts dose 5mg (shared statementId — the same logical fact synced earlier).
  await s.assert("p@A", { statementId: "m1", subject: "p", predicate: "takes", object: { dose: "5mg" }, validFrom: "2024-01-01" });
  // Device B later corrects the SAME statement to 2.5mg.
  clk.t = "2026-02-01T00:00:00.000Z";
  await s.correct("p@B", "m1", { object: { dose: "2.5mg" } });
  const view = await s.foldView("p", { subject: "p", validAt: "2026-06-01" });
  assert.equal(view.facts.length, 1, "one logical fact across two devices");
  assert.equal(view.facts[0].object.dose, "2.5mg", "the later correction wins");
});
