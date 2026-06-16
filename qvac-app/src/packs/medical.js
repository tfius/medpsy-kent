// Medical domain PACK for @qvac/kgraph — the app-side layer that gives the domain-neutral
// graph engine its medical vocabulary. It deliberately REUSES the already-curated assets in
// src/medlens.js (the authored interaction list + the drug-name → canonical-id resolver), so
// there is ONE source of curated medical facts. The graph lives in the existing `kb:medical`
// log (kept by alias, per KGRAPH_DESIGN §10.5) — so the federated/audited interaction graph
// medlens + the mesh already grow is exactly what the kgraph recipes read.
//
// v1 grounds only on FACTUAL relations (interactions). `indicates` (symptom→condition) is
// declared associative so the engine refuses to ground a differential on it (suggest-only).
import { createKnowledgeGraph } from "@qvac/kgraph";
import { drugId, seedInteractions } from "../medlens.js";

export const MEDICAL_LOG = "kb:medical";

export const MEDICAL_PACK = {
  log: MEDICAL_LOG,
  ontology: {
    kinds: [{ name: "drug" }, { name: "condition" }, { name: "symptom" }, { name: "icd" }],
    predicates: [
      // FACTUAL — may ground a decision:
      { name: "interacts_with", epistemics: "factual", valueType: "ref", symmetric: true, domain: ["drug"], range: ["drug"] },
      { name: "contraindicated_in", epistemics: "factual", valueType: "ref", domain: ["drug"], range: ["condition"] },
      { name: "codes_as", epistemics: "factual", valueType: "ref", domain: ["condition"], range: ["icd"] },
      // ASSOCIATIVE — suggest-only; the engine refuses to GROUND on these (no graph "differential"):
      { name: "indicates", epistemics: "associative", valueType: "ref", domain: ["symptom"], range: ["condition"] },
    ],
  },
};

// Build a medical knowledge graph over `store`, seeding the curated interaction edges
// (idempotent — medlens.seedInteractions uses deterministic ids). Returns the kgraph.
export async function medicalGraph(store, { log = MEDICAL_LOG } = {}) {
  const kg = createKnowledgeGraph(store, { pack: { ...MEDICAL_PACK, log } });
  await seedInteractions(store, { log });   // reuse the AUTHORED, curated interaction list
  kg.refresh();                              // index now reflects the seeded edges
  return kg;
}

// Screen a set of drug names (free text ok — resolved via medlens.drugId) for interactions.
// Grounded: factual + confirmed-only (un-vetted candidate edges never surface here). Returns
// interacting pairs with severity/note + the factstore receipts that ground them.
export async function screenInteractions(kg, drugNames = []) {
  const ids = [...new Set(drugNames.map(drugId).filter((d) => d && d !== "drug:"))];
  const pairs = await kg.pairsAmong(ids, { predicates: ["interacts_with"], confirmedOnly: true });
  return pairs.map((e) => ({ a: e.from, b: e.to, severity: e.meta?.severity, note: e.meta?.note, receipt: { statementId: e.statementId, hash: e.hash } }));
}

export { drugId };
