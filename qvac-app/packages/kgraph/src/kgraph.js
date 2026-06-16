// @qvac/kgraph — a domain-neutral knowledge graph built OVER a @qvac/factstore instance.
//
// "Build-over, don't-modify": this never imports factstore — it takes a store by INJECTION
// and uses only its public read/write API (assert / fold / foldView). All the new behaviour —
// typed nodes/edges, schema + epistemics, bounded traversal, a materialized adjacency index,
// and the factual-only grounding rule — lives here. Factstore stays frozen.
//
// Safety invariants (see KGRAPH_DESIGN.md):
//   - ground() may traverse ONLY `factual` predicates; `associative` ones suggest, never conclude.
//   - graph invariants (symmetry) are DERIVED AT READ time (the CRDT merges statements, not
//     invariants), so an edge is written ONCE and symmetric edges are reachable both ways.
//   - identity is immutable; edges have deterministic ids (idempotent seeding); all bounded.
import { createSchema, loadSchema, seedSchema, kindOf } from "./schema.js";

const MAX_DEPTH = 4, MAX_HOPS = 4;
// Free-text → a node key. NOTE: this lowercases/slugs, which is right for free-text labels but
// would mangle a CODE — for standard-vocab nodes pass the id directly (e.g. "icd:I21.9").
const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// Deterministic edge id so re-asserting (from,predicate,to) UPSERTS — idempotent seeding.
const edgeId = (from, predicate, to) => `e:${from}|${predicate}|${to}`;

export class KnowledgeGraph {
  constructor(store, { schema, log = "kg:default", source = "authored" } = {}) {
    if (!store || typeof store.assert !== "function") throw new Error("KnowledgeGraph needs a factstore instance");
    if (!schema) throw new Error("KnowledgeGraph needs a schema (pass { pack } to createKnowledgeGraph)");
    this.store = store;
    this.schema = schema;
    this.log = log;
    this.defaultSource = source;
    this._out = new Map();   // from -> edge[]   (materialized adjacency index, current graph)
    this._in = new Map();    // to   -> edge[]
    this._indexed = false;
  }

  nodeId(kind, key) { return `${kind}:${slug(key)}`; }

  // --- writes ---
  async assertNode(id, { kind, attrs = {}, source = this.defaultSource, validFrom = null } = {}) {
    const k = kind || kindOf(id);
    if (!k) throw new Error(`assertNode '${id}': cannot determine kind (use "<kind>:<key>" or pass { kind })`);
    await this.store.assert(this.log, { statementId: `${id}#kind`, subject: id, predicate: "kind", object: k, source });
    for (const [name, value] of Object.entries(attrs)) {
      if (name === "kind") continue; // kind is asserted above; don't shadow it
      await this.store.assert(this.log, { statementId: `${id}#${name}`, subject: id, predicate: name, object: value, source, validFrom });
    }
    return id;
  }

  // Write ONE direction; symmetry/inverse are derived at read. Deterministic id → idempotent.
  // Forward-compatible: an unschema'd predicate is tagged + still written (never dropped).
  async assertEdge({ from, predicate, to, meta = {}, source = this.defaultSource, confidence = 1, statementId, validFrom = null }) {
    const v = this.schema.validateEdge({ from, predicate, to });
    if (!v.ok) throw new Error(`assertEdge: ${v.warnings.join("; ")}`);
    const sid = statementId || edgeId(from, predicate, to);
    const m = { ...meta, epistemics: this.schema.predicate(predicate)?.epistemics ?? "unschemad", ...(v.unschemad ? { unschemad: true } : {}) };
    const rec = await this.store.assert(this.log, { statementId: sid, subject: from, predicate, object: { ref: to }, meta: m, source, confidence, validFrom });
    if (this._indexed) this._indexEdge({ from, predicate, to, meta: m, confidence, statementId: sid, hash: rec?.hash });
    return { from, predicate, to, statementId: sid, warnings: v.warnings };
  }

  // --- materialized index (current asserted graph) ---
  async ensureIndex() {
    if (this._indexed) return;
    const { facts } = await this.store.foldView(this.log);          // foldView already drops retracted + upserts
    this._out.clear(); this._in.clear();
    for (const e of this._edgesFromFacts(facts)) this._indexEdge(e);
    this._indexed = true;
  }
  // Rebuild the index from the store. Call after external mutations (confirm/reject/retract/
  // promote) so traversal doesn't serve stale edges.
  refresh() { this._out.clear(); this._in.clear(); this._indexed = false; }

  _edgesFromFacts(facts) {
    const out = [];
    for (const f of facts) {
      const ref = f.object && typeof f.object === "object" ? f.object.ref : undefined;
      if (!ref) continue; // attributes (literals) aren't edges
      out.push({ from: f.subject, predicate: f.predicate, to: ref, meta: f.meta || {}, confidence: f.confidence ?? 1, statementId: f.statementId, hash: f.hash });
    }
    return out;
  }
  _indexEdge(e) {
    for (const [map, key] of [[this._out, e.from], [this._in, e.to]]) {
      if (!map.has(key)) map.set(key, []);
      const arr = map.get(key);
      const i = arr.findIndex((x) => x.statementId === e.statementId);
      if (i >= 0) arr[i] = e; else arr.push(e); // upsert by statementId (re-assert doesn't duplicate)
    }
  }

  // Edges incident to `id`. `slice` (validAt/knownAt) bypasses the index → fold-with-slice
  // (preserving meta + confidence); otherwise the materialized current-graph index.
  async _incident(id, slice) {
    if (!slice) { await this.ensureIndex(); return { out: this._out.get(id) || [], in: this._in.get(id) || [] }; }
    const { facts } = await this.store.foldView(this.log, { validAt: slice.validAt, knownAt: slice.knownAt });
    const edges = this._edgesFromFacts(facts);
    return { out: edges.filter((e) => e.from === id), in: edges.filter((e) => e.to === id) };
  }

  // --- reads / traversal ---
  async getNode(id, slice) {
    const { facts } = await this.store.foldView(this.log, { subject: id, ...(slice || {}) });
    const attrs = {}; let kind = kindOf(id); let declared = false;
    for (const f of facts) {
      if (f.object && typeof f.object === "object" && f.object.ref) continue; // skip edges
      if (f.predicate === "kind") { kind = f.object; declared = true; } else attrs[f.predicate] = f.object;
    }
    // `exists` = was the node DECLARED (asserted via assertNode → has a `kind` fact); a node that
    // only appears as an edge target isn't "known" yet (matters for entity resolution in packs).
    return { id, kind, attrs, exists: declared };
  }

  // One-hop edges. Symmetric predicates are bidirectional (derived); directed predicates go
  // outward by default. Deduped per (predicate, neighbor) so a symmetric edge isn't double-listed.
  async neighbors(id, { predicates, kinds, dir = "out", minConfidence = 0, confirmedOnly = false, slice } = {}) {
    const { out: outE, in: inE } = await this._incident(id, slice);
    const acc = new Map(); // key (predicate|neighbor) -> edge (first wins)
    const take = (e, d) => {
      if (confirmedOnly && e.meta?.proposed === true) return; // un-vetted candidates never count in a grounded read
      if (predicates && !predicates.includes(e.predicate)) return;
      if ((e.confidence ?? 1) < minConfidence) return;
      const neighbor = d === "out" ? e.to : e.from;
      if (kinds && !kinds.includes(kindOf(neighbor))) return;
      const key = `${e.predicate}|${neighbor}`;
      if (!acc.has(key)) acc.set(key, { from: e.from, predicate: e.predicate, to: e.to, meta: e.meta || {}, confidence: e.confidence ?? 1, statementId: e.statementId, hash: e.hash, neighbor, dir: d });
    };
    if (dir === "out" || dir === "both") for (const e of outE) take(e, "out");
    for (const e of inE) {
      if (dir === "in" || dir === "both" || (dir === "out" && this.schema.isSymmetric(e.predicate))) take(e, "in");
    }
    return [...acc.values()];
  }

  // Depth-bounded neighbourhood subgraph.
  async expand(id, { depth = 1, predicates, kinds, minConfidence = 0, confirmedOnly = false, dir, slice } = {}) {
    const d = Math.min(depth, MAX_DEPTH);
    const seen = new Set([id]); const edges = []; let frontier = [id];
    for (let i = 0; i < d; i++) {
      const next = [];
      for (const node of frontier) {
        for (const e of await this.neighbors(node, { predicates, kinds, minConfidence, confirmedOnly, dir, slice })) {
          edges.push(e);
          if (!seen.has(e.neighbor)) { seen.add(e.neighbor); next.push(e.neighbor); }
        }
      }
      frontier = next;
    }
    return { nodes: [...seen], edges };
  }

  // Bounded simple-path enumeration → ranked by aggregate (product) confidence → top-k. (§10.4)
  async paths(from, to, { maxHops = 2, predicates, minConfidence = 0, topK = 5, slice } = {}) {
    const cap = Math.min(maxHops, MAX_HOPS);
    const results = [];
    const prod = (p) => p.reduce((a, e) => a * (e.confidence ?? 1), 1);
    const walk = async (node, path, visited) => {
      if (node === to && path.length > 0) { results.push(path); return; }
      if (path.length >= cap) return;
      for (const e of await this.neighbors(node, { predicates, minConfidence, slice })) {
        if (visited.has(e.neighbor)) continue;
        await walk(e.neighbor, [...path, e], new Set(visited).add(e.neighbor));
      }
    };
    await walk(from, [], new Set([from]));
    results.sort((a, b) => prod(b) - prod(a));
    return results.slice(0, topK).map((p) => ({ hops: p.length, confidence: prod(p), edges: p }));
  }

  // Run a grounding recipe. mode "ground" enforces the factual-only rule (throws on an
  // associative/unschema'd predicate). Returns { answer, edges, receipts } — receipts pin the
  // exact factstore statements the answer stands on. Inputs come bound (not free LLM text).
  async ground(recipe, params = {}, slice) {
    const via = recipe.via || [];
    const mode = recipe.mode || "ground";
    if (mode === "ground") {
      for (const p of via) {
        if (!this.schema.isFactual(p)) {
          throw new Error(`recipe '${recipe.id}': cannot GROUND on '${p}' — it is ${this.schema.predicate(p)?.epistemics || "unschema'd"} (suggest-only). Use mode:"suggest".`);
        }
      }
    }
    const start = params[recipe.from];
    if (!start) throw new Error(`recipe '${recipe.id}' requires param '${recipe.from}'`);
    // A grounded read excludes un-vetted candidates (meta.proposed); suggest-mode may include them.
    const sub = await this.expand(start, { depth: recipe.depth ?? 1, predicates: via, minConfidence: recipe.minConfidence ?? 0, confirmedOnly: mode === "ground", slice });
    return {
      recipe: recipe.id, mode,
      answer: sub.nodes.filter((n) => n !== start),
      edges: sub.edges,
      receipts: sub.edges.map((e) => ({ statementId: e.statementId, hash: e.hash, predicate: e.predicate })),
    };
  }
}

export function createKnowledgeGraph(store, { pack, schema, log, source } = {}) {
  const sch = schema || createSchema(pack?.ontology || {});
  return new KnowledgeGraph(store, { schema: sch, log: log ?? pack?.log ?? "kg:default", source });
}

export { createSchema, loadSchema, seedSchema, kindOf };
