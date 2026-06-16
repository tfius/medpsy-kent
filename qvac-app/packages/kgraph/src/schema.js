// Ontology / schema for a knowledge-graph pack. Domain-NEUTRAL: this file knows nothing
// about any domain — a pack supplies `kinds` + `predicates` as data.
//
// The load-bearing field is `epistemics`:
//   "factual"     — deterministic, curated relations a decision may GROUND on
//   "associative" — probabilistic/contextual priors that may only SUGGEST, never conclude
//
// Schema is itself data (seed it into a factstore log via seedSchema → bi-temporal,
// federatable, introspectable); createSchema(ontology) is the in-memory registry used at
// runtime. Validation is FORWARD-COMPATIBLE: an unknown kind/predicate is flagged, never
// rejected (so a mesh peer on a newer pack can't have its edges silently dropped).

export function createSchema(ontology = {}) {
  const kinds = new Map((ontology.kinds || []).map((k) => [k.name, k]));
  const predicates = new Map((ontology.predicates || []).map((p) => [p.name, normalizePredicate(p)]));

  const predicate = (name) => predicates.get(name);
  const isKnownPredicate = (name) => predicates.has(name);
  const isKnownKind = (name) => kinds.has(name);
  const isFactual = (name) => predicate(name)?.epistemics === "factual";
  const isAssociative = (name) => predicate(name)?.epistemics === "associative";
  const isSymmetric = (name) => !!predicate(name)?.symmetric;

  // Forward-compatible: returns { ok, warnings[] }. ok is always true for a well-formed
  // statement; an unknown predicate / domain-range mismatch is a WARNING, not a rejection.
  function validateEdge({ from, predicate: pred, to }) {
    const warnings = [];
    if (!from || !pred || !to) return { ok: false, warnings: ["edge requires from, predicate, to"] };
    const def = predicate(pred);
    if (!def) { warnings.push(`unschema'd predicate '${pred}'`); return { ok: true, warnings, unschemad: true }; }
    if (def.valueType !== "ref") warnings.push(`predicate '${pred}' is valueType '${def.valueType}', not a ref edge`);
    const kFrom = kindOf(from), kTo = kindOf(to);
    if (def.domain && !def.domain.includes(kFrom)) warnings.push(`'${pred}' domain ${JSON.stringify(def.domain)} excludes '${kFrom}'`);
    if (def.range && !def.range.includes(kTo)) warnings.push(`'${pred}' range ${JSON.stringify(def.range)} excludes '${kTo}'`);
    return { ok: true, warnings, unschemad: false };
  }

  return {
    kinds, predicates, ontology,
    predicate, isKnownPredicate, isKnownKind, isFactual, isAssociative, isSymmetric, validateEdge,
    predicateNames: () => [...predicates.keys()],
    kindNames: () => [...kinds.keys()],
    factualPredicates: () => [...predicates.values()].filter((p) => p.epistemics === "factual").map((p) => p.name),
  };
}

function normalizePredicate(p) {
  if (!p.name) throw new Error("predicate requires a name");
  const epistemics = p.epistemics || "factual";
  if (epistemics !== "factual" && epistemics !== "associative") {
    throw new Error(`predicate '${p.name}': epistemics must be 'factual' or 'associative'`);
  }
  return {
    name: p.name, epistemics, valueType: p.valueType || "ref",
    domain: p.domain, range: p.range,
    symmetric: !!p.symmetric, inverseOf: p.inverseOf,
    cardinality: p.cardinality || "many",
  };
}

// kind from a node id: "<kind>:<key>" → "<kind>" (first ':' splits; key carries no ':').
export const kindOf = (id) => (typeof id === "string" && id.includes(":") ? id.slice(0, id.indexOf(":")) : "");

// --- schema-as-data: persist / load the ontology to a factstore log (bi-temporal, federatable) ---
// Idempotent (deterministic statementIds), mirroring how medlens seeds its edges.
export async function seedSchema(store, log, ontology) {
  for (const k of ontology.kinds || []) {
    await store.assert(log, { statementId: `kg:kind:${k.name}`, subject: `kg:kind:${k.name}`, predicate: "kg_kind", object: k, source: "schema" });
  }
  for (const p of ontology.predicates || []) {
    await store.assert(log, { statementId: `kg:pred:${p.name}`, subject: `kg:pred:${p.name}`, predicate: "kg_predicate", object: normalizePredicate(p), source: "schema" });
  }
}

export async function loadSchema(store, log) {
  const { facts } = await store.foldView(log);
  const ontology = { kinds: [], predicates: [] };
  for (const f of facts) {
    if (f.predicate === "kg_kind") ontology.kinds.push(f.object);
    else if (f.predicate === "kg_predicate") ontology.predicates.push(f.object);
  }
  return createSchema(ontology);
}
