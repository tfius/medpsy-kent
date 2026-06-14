// Medical lens over @qvac/factstore — the domain layer the agnostic substrate stays free
// of. Holds the AUTHORED drug-interaction graph (hand-curated from the knowledge-base
// monographs, NOT LLM-extracted) in a shared `kb:medical` log, and screens a proposed
// medication against the patient's CURRENT meds by traversing it (store.edgesAmong).
// Deterministic and grounded — the interaction comes from authored edges + recorded meds,
// not the model's memory or a fuzzy prose match.

// A small curated synonym map (salt forms, brand/US names, abbreviations) -> the canonical
// graph node. A missed match is a dangerous interaction false-negative, so the common
// aliases for the drugs in the interaction graph are covered here. Full coverage needs an
// RxNorm/dm+d mapping — this is the pragmatic subset.
const SYNONYMS = {
  "acetylsalicylic-acid": "aspirin", "asa": "aspirin",
  "acetaminophen": "paracetamol",
  "albuterol": "salbutamol",
  "warfarin-sodium": "warfarin", "coumadin": "warfarin",
  "frusemide": "furosemide", "lasix": "furosemide",
  "glyceryl-trinitrate": "gtn", "nitroglycerin": "gtn", "nitroglycerine": "gtn", "trinitrate": "gtn",
  "nurofen": "ibuprofen", "brufen": "ibuprofen",
  "viagra": "sildenafil",
  "septrin": "trimethoprim", "co-trimoxazole": "trimethoprim",
};

// Normalize a drug name to a graph id: strip dose/strength ("Warfarin 5mg" -> warfarin),
// slugify, then map known synonyms to the canonical node.
export const drugId = (name) => {
  const slug = String(name || "").toLowerCase().trim()
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml|units?|iu|%)\b.*$/i, "") // drop "5mg ...", "400 mg", etc.
    .replace(/\b(spray|tablets?|tabs?|caps?|capsules?|cream|gel|patch(es)?|inhaler|oral|solution|injection|drops?|liquid|suspension|sachets?|modified[- ]release|mr|sr|er|xl)\b/gi, "") // drop form/route words
    .trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return "drug:" + (SYNONYMS[slug] || slug);
};

// Authored interaction edges (a, b) with severity + a one-line rationale. Curated from
// data/knowledge/*.md. Add to this list as the corpus grows; it's data, not inference.
const INTERACTIONS = [
  ["warfarin", "ibuprofen", "major", "NSAID + anticoagulant — bleeding risk (GI + antiplatelet)"],
  ["warfarin", "aspirin", "major", "antiplatelet + anticoagulant — bleeding risk"],
  ["warfarin", "clarithromycin", "major", "CYP inhibition raises INR — bleeding risk"],
  ["warfarin", "naproxen", "major", "NSAID + anticoagulant — bleeding risk"],
  ["sertraline", "tramadol", "major", "serotonin syndrome risk (two serotonergic agents)"],
  ["sertraline", "linezolid", "major", "linezolid is an MAOI — serotonin syndrome"],
  ["ramipril", "spironolactone", "moderate", "hyperkalaemia risk"],
  ["ramipril", "ibuprofen", "moderate", "triple-whammy AKI risk (with a diuretic)"],
  ["gtn", "sildenafil", "major", "nitrate + PDE5 inhibitor — profound hypotension"],
  ["simvastatin", "clarithromycin", "major", "CYP3A4 inhibition — myopathy/rhabdomyolysis"],
  ["methotrexate", "trimethoprim", "major", "additive antifolate — marrow suppression"],
  ["lithium", "ibuprofen", "major", "reduced renal clearance — lithium toxicity"],
];

// Seed the interaction graph into `kb:medical` (idempotent — deterministic statementIds,
// so re-seeding an updated list upserts rather than duplicates). Skips entirely when the
// full set is already present, so it doesn't append redundant records on every restart.
// Edges are bidirectional.
export async function seedInteractions(store, { log = "kb:medical" } = {}) {
  const present = (await store.fold(log, { predicate: "interacts_with" })).facts.length;
  if (present >= INTERACTIONS.length * 2) return { seeded: 0 };
  for (const [a, b, severity, note] of INTERACTIONS) {
    const [da, db] = [drugId(a), drugId(b)];
    const meta = { severity, note, schema: "medical/interaction" };
    await store.assert(log, { statementId: `ix:${da}>${db}`, subject: da, predicate: "interacts_with", object: { ref: db }, source: "authored", meta });
    await store.assert(log, { statementId: `ix:${db}>${da}`, subject: db, predicate: "interacts_with", object: { ref: da }, source: "authored", meta });
  }
  return { seeded: INTERACTIONS.length * 2 };
}

// Screen a candidate drug against the patient's current meds (drug refs or names). The
// interaction GRAPH can live in a different store than the patient meds — pass `kbStore` to
// read the graph from a replicated, shared knowledge store (see src/kb-sync.js) while the
// PHI meds stay in the local store.
export async function screenInteractions(store, { patientLog, candidate, kbLog = "kb:medical", kbStore = store, includeProposed = false }) {
  const meds = (await store.fold(patientLog, { predicate: "takes" })).facts;
  const drugIds = meds.map((f) => (f.object && f.object.ref) || drugId(f.object?.name)).filter((d) => d && d !== "drug:");
  const candId = candidate ? drugId(candidate) : null;
  const set = [...new Set(candId ? [...drugIds, candId] : drugIds)];
  const edges = await kbStore.edgesAmong(kbLog, set, { predicate: "interacts_with" });
  // Dedup the bidirectional pair, and (if a candidate is given) keep only edges touching it.
  const seen = new Set(), out = [];
  for (const e of edges) {
    // NEVER ground on an un-vetted CANDIDATE edge (edge-learning proposals) — only promoted ones.
    if (!includeProposed && e.meta?.proposed) continue;
    if (candId && e.from !== candId && e.to !== candId) continue;
    const key = [e.from, e.to].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: e.from, b: e.to, severity: e.meta?.severity, note: e.meta?.note });
  }
  return out;
}

// A graph-grounded interaction-check tool for the agent (distinct from the keyword
// check_interactions): traverses the authored graph against the patient's recorded meds.
export function makeInteractionTool(store, { patientLog, kbLog = "kb:medical", kbStore = store }) {
  return {
    def: { type: "function", function: {
      name: "screen_interactions",
      description: "Screen a proposed/new medication against the patient's CURRENT medications using the on-device interaction graph. Deterministic — returns interacting pairs with severity. Use for any 'is X safe to add for this patient' question.",
      parameters: { type: "object", properties: {
        candidate: { type: "string", description: "the proposed drug name, e.g. 'ibuprofen' (omit to screen the patient's existing meds against each other)" },
      } } } },
    run: async ({ candidate }) => ({ interactions: await screenInteractions(store, { patientLog, candidate, kbLog, kbStore }) }),
  };
}
