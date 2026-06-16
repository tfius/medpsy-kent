// EVAL GATE for the medical interaction pack (@qvac/kgraph + src/packs/medical.js).
//   node scripts/medpack_eval.mjs        (npm run eval:medpack)
//
// What this gates — and, honestly, what it does NOT. This pack is a TARGETED safety net over
// a hand-curated interaction list, not a comprehensive interaction database. So the gate is:
// "does the system faithfully + safely surface the CURATED knowledge, and resolve the drug
// names it CLAIMS to handle?" It does not measure coverage of all real-world interactions —
// growing the curated corpus is tracked separately (and reported below as scope, not failure).
//
// The gate is ASYMMETRIC by design: a MISSED interaction (false negative) is dangerous; a
// spurious flag is merely noise. So zero false-negatives is the HARD gate (exit 1). The two
// failure surfaces:
//   1. Entity resolution — a drug name (brand / dose-suffixed / form / synonym) that fails to
//      resolve silently drops that drug's interactions. This is the dangerous class (the review
//      just caught `naproxen 250` and `Advil`). Tested systematically via generated variants.
//   2. Graph retrieval — every curated interaction must surface (correct severity); non-
//      interacting controls must return []; the confirmed-only / associative gates must hold.
// Curated VALUES (severities) and membership are pinned to a frozen golden (§0) so a fat-fingered
// severity or a deleted interaction fails the gate instead of passing green (review C1/M1).
import { createFactStore } from "@qvac/factstore";
import { medicalGraph, screenInteractions } from "../src/packs/medical.js";
import { drugId, INTERACTIONS, SYNONYMS } from "../src/medlens.js";

const fn = [];   // false negatives — the DANGEROUS class (recall miss / unresolved / mismapped / wrong severity)
const fp = [];   // false positives — spurious interactions (noise; also gated, they're deterministic)
let checks = 0;
const expect = (cond, bucket, msg) => { checks++; if (!cond) bucket.push(msg); };

const kg = await medicalGraph(createFactStore());
const id = (n) => `drug:${n}`;
const pairKey = (a, b) => [a, b].sort().join("|");
const drugs = [...new Set(INTERACTIONS.flatMap(([a, b]) => [a, b]))].sort();
const ikey = (a, b) => [a, b].sort().join("|");

// ── 0. CURATED-DATA ORACLE (independent of the source list) ─────────────────────────────────
// The recall loop (§2) only proves the curated VALUE survives seed→screen — it cannot catch a
// fat-fingered severity (clinically, a dangerous UNDER-warning) or a silently deleted/added
// interaction, because both sides come from the same INTERACTIONS literal (review C1/M1). So we
// pin a FROZEN, separately-reviewed snapshot here: any curation change must be a deliberate
// two-place edit reviewed against this golden, not a silent green pass.
const GOLDEN = {
  "ibuprofen|warfarin": "major", "aspirin|warfarin": "major", "clarithromycin|warfarin": "major",
  "naproxen|warfarin": "major", "sertraline|tramadol": "major", "linezolid|sertraline": "major",
  "ramipril|spironolactone": "moderate", "ibuprofen|ramipril": "moderate", "gtn|sildenafil": "major",
  "clarithromycin|simvastatin": "major", "methotrexate|trimethoprim": "major", "ibuprofen|lithium": "major",
};
expect(Object.keys(GOLDEN).length === INTERACTIONS.length, fn,
  `ORACLE: curated count ${INTERACTIONS.length} ≠ reviewed golden ${Object.keys(GOLDEN).length} — review the change, then update GOLDEN`);
const curatedKeys = new Set();
for (const [a, b, severity] of INTERACTIONS) {
  const k = ikey(a, b); curatedKeys.add(k);
  expect(GOLDEN[k] === severity, fn, `ORACLE: ${a} ↔ ${b} severity "${severity}" ≠ reviewed "${GOLDEN[k] ?? "(not in golden)"}"`);
}
for (const k of Object.keys(GOLDEN))
  expect(curatedKeys.has(k), fn, `ORACLE: reviewed interaction "${k}" was DELETED from the curated list`);

// ── 1. ENTITY RESOLUTION (the dangerous surface) ──────────────────────────────────────────
// (a) Every curated drug must resolve from its canonical name + realistic free-text variants.
//     Dose numbers are arbitrary — we're testing the STRIP, not real strengths.
const variants = (d) => [
  d, d[0].toUpperCase() + d.slice(1),
  `${d} 5mg`, `${d} 10 mg`, `${d} 400mg tablets`,
  `${d} 250`,                 // bare trailing strength (review M3)
  `${d} tablets`, `${d} oral`, `${d} MR`,
];
for (const d of drugs) for (const v of variants(d))
  expect(drugId(v) === id(d), fn, `ER: "${v}" → ${drugId(v)} (expected ${id(d)})`);

// (b) Every synonym must round-trip to the SAME canonical node as its target (catches a
//     synonym that maps to the wrong drug — an ER collision that would cause FN *and* FP).
for (const [alias, canon] of Object.entries(SYNONYMS))
  expect(drugId(alias) === drugId(canon), fn, `ER synonym: "${alias}" → ${drugId(alias)} (expected ${drugId(canon)})`);

// (c) High-risk BRAND watchlist for the interacting drugs (independent ground truth — well-
//     established nomenclature). A brand here that isn't covered fails the gate, forcing it to
//     be added to SYNONYMS — this is the mechanism that catches the M4-class miss (e.g. Advil).
const BRAND_WATCHLIST = {
  warfarin: ["Coumadin"], ibuprofen: ["Advil", "Motrin", "Nurofen", "Brufen"],
  aspirin: ["ASA"], clarithromycin: ["Biaxin", "Klaricid"], naproxen: ["Naprosyn", "Aleve"],
  sertraline: ["Zoloft", "Lustral"], tramadol: ["Ultram", "Zydol"], linezolid: ["Zyvox"],
  ramipril: ["Altace", "Tritace"], spironolactone: ["Aldactone"], sildenafil: ["Viagra", "Revatio"],
  simvastatin: ["Zocor"], methotrexate: ["Rheumatrex", "Trexall", "MTX"],
  lithium: ["Priadel", "Camcolit", "Eskalith"], trimethoprim: ["Septrin", "Bactrim"],
};
for (const [canon, brands] of Object.entries(BRAND_WATCHLIST)) for (const b of brands)
  expect(drugId(b) === id(canon), fn, `ER brand: "${b}" → ${drugId(b)} (expected ${id(canon)})`);

// ── 2. RECALL (every curated interaction must surface, with correct severity) ───────────────
for (const [a, b, severity] of INTERACTIONS) {
  const hit = (await screenInteractions(kg, [a, b])).find((h) => pairKey(h.a, h.b) === pairKey(id(a), id(b)));
  expect(hit, fn, `RECALL: ${a} ↔ ${b} not surfaced`);
  if (hit) {
    expect(hit.severity === severity, fn, `SEVERITY: ${a} ↔ ${b} = "${hit.severity}" (expected "${severity}")`);
    expect(hit.receipt?.hash, fn, `GROUNDING: ${a} ↔ ${b} surfaced without a factstore receipt`);
  }
}

// ── 3. COMPOSITION (ER + retrieval together — the real free-text scenario) ──────────────────
for (const [names, a, b] of [
  [["Coumadin", "Advil 400mg"], "warfarin", "ibuprofen"],
  [["naproxen 250", "warfarin 5mg"], "warfarin", "naproxen"],
  [["Zoloft 50mg", "Zydol"], "sertraline", "tramadol"],
]) {
  const found = (await screenInteractions(kg, names)).some((h) => pairKey(h.a, h.b) === pairKey(id(a), id(b)));
  expect(found, fn, `COMPOSE: ${JSON.stringify(names)} should find ${a} ↔ ${b}`);
}

// ── 4. PRECISION (non-interacting controls → [] ; mixed set → exactly the real pairs) ───────
for (const pair of [["paracetamol", "amoxicillin"], ["amoxicillin", "cetirizine"], ["salbutamol", "paracetamol"]])
  expect((await screenInteractions(kg, pair)).length === 0, fp, `SPURIOUS: ${pair.join(" + ")} flagged`);
expect((await screenInteractions(kg, ["warfarin", "ibuprofen", "paracetamol", "amoxicillin"])).length === 1, fp,
  "MIXED SET: warfarin+ibuprofen(+2 inert) should yield exactly 1 pair");

// ── 5. SAFETY INVARIANTS (un-vetted candidates inert; associative cannot ground) ───────────
await kg.assertEdge({ from: id("metformin"), predicate: "interacts_with", to: id("ranitidine"), confidence: 0.5, meta: { proposed: 1, severity: "moderate" } });
expect((await screenInteractions(kg, ["metformin", "ranitidine"])).length === 0, fn, "GATE: proposed edge surfaced before confirmation");
await kg.confirmEdge(id("metformin"), "interacts_with", id("ranitidine"));
expect((await screenInteractions(kg, ["metformin", "ranitidine"])).length === 1, fn, "GATE: confirmed edge failed to surface");
let refused = false;
await kg.assertEdge({ from: "symptom:chest-pain", predicate: "indicates", to: "condition:mi" });
try { await kg.ground({ id: "differential", from: "s", via: ["indicates"] }, { s: "symptom:chest-pain" }); }
catch (e) { refused = /associative|suggest-only/.test(e.message); }
expect(refused, fn, "GATE: associative `indicates` was allowed to ground a differential");

// ── REPORT ──────────────────────────────────────────────────────────────────────────────────
const variantsPerDrug = variants("x").length;
const brandCount = Object.values(BRAND_WATCHLIST).reduce((n, b) => n + b.length, 0);
console.log(`\nMedical interaction pack — eval gate`);
console.log(`scope (honest): faithful + safe surfacing of the CURATED graph + claimed name variants.`);
console.log(`                NOT a measure of real-world interaction coverage — that's a curation task.`);
console.log(`\ncoverage tested:`);
console.log(`  ${INTERACTIONS.length} curated interactions (severity + membership pinned to a reviewed golden) · ${drugs.length} unique drugs`);
console.log(`  ${drugs.length * variantsPerDrug} generated name-variants · ${Object.keys(SYNONYMS).length} synonyms · ${brandCount} watchlist brands`);
console.log(`  ${checks} assertions total`);
console.log(`\nresults:`);
console.log(`  false NEGATIVES (dangerous, gated): ${fn.length}`);
console.log(`  false positives  (noise, gated):    ${fp.length}`);
for (const m of fn) console.log(`    ✗ FN  ${m}`);
for (const m of fp) console.log(`    ✗ FP  ${m}`);

const pass = fn.length === 0 && fp.length === 0;
console.log(`\n${pass ? "PASS" : "FAIL"} — interaction-pack eval gate ${pass ? "green" : `RED (${fn.length} FN, ${fp.length} FP)`}\n`);
process.exit(pass ? 0 : 1);
