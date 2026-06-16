// Smoke: the medical kgraph pack reads the curated interaction graph through @qvac/kgraph and
// screens drugs — proving Phase-1 kgraph + the medical pack work together, with the
// factual + confirmed-only grounding rule and the entity-resolution safety net intact.
//   node scripts/medpack_smoke.mjs
import assert from "node:assert/strict";
import { createFactStore } from "@qvac/factstore";
import { medicalGraph, screenInteractions, drugId } from "../src/packs/medical.js";

const kg = await medicalGraph(createFactStore());
const pairKey = (h) => [h.a, h.b].sort().join("|");
const has = (hits, a, b) => hits.some((h) => pairKey(h) === [drugId(a), drugId(b)].sort().join("|"));

// 1) a known major interaction surfaces (dose/brand names resolve via drugId)
const hits = await screenInteractions(kg, ["Warfarin 5mg", "Nurofen 400mg", "paracetamol"]);
assert.ok(has(hits, "warfarin", "ibuprofen"), "warfarin + ibuprofen must be found");
assert.ok(hits.find((h) => has([h], "warfarin", "ibuprofen")).receipt?.hash, "grounded with a factstore receipt");
console.log("✓ interaction found (warfarin ↔ ibuprofen, major) with receipt");

// 2) entity-resolution false-negative guards (the dangerous miss class — review M3/M4)
assert.ok((await screenInteractions(kg, ["warfarin", "naproxen 250"])).length === 1, "bare-dose 'naproxen 250' must still resolve");
assert.ok(has(await screenInteractions(kg, ["warfarin", "Advil"]), "warfarin", "ibuprofen"), "brand 'Advil' must resolve to ibuprofen");
assert.equal(drugId("amoxicillin"), "drug:amoxicillin", "positive resolution control");
console.log("✓ ER: dose-stripped + brand names resolve (no silent false-negatives)");

// 3) no false positives for a safe, resolvable pair
assert.equal((await screenInteractions(kg, ["paracetamol", "amoxicillin"])).length, 0, "no spurious interactions");
console.log("✓ safe pair → no interactions");

// 4) THE safety gate: an un-vetted (proposed) edge must NOT surface in a grounded screen,
//    even when meta.proposed is a truthy non-boolean (guards the strict-=== bug). Confirming it does.
await kg.assertEdge({ from: drugId("metformin"), predicate: "interacts_with", to: drugId("ranitidine"), confidence: 0.5, meta: { proposed: 1, severity: "moderate" } });
assert.equal((await screenInteractions(kg, ["metformin", "ranitidine"])).length, 0, "candidate edge must NOT ground a screen");
await kg.confirmEdge(drugId("metformin"), "interacts_with", drugId("ranitidine"));
assert.equal((await screenInteractions(kg, ["metformin", "ranitidine"])).length, 1, "after clinician confirm, it surfaces");
console.log("✓ proposed→confirmed gate: candidates inert until vetted");

// 5) the engine REFUSES to ground a differential on the associative `indicates` predicate
await kg.assertEdge({ from: "symptom:chest-pain", predicate: "indicates", to: "condition:mi" });
await assert.rejects(
  () => kg.ground({ id: "differential", from: "s", via: ["indicates"] }, { s: "symptom:chest-pain" }),
  /associative|suggest-only/,
  "must refuse to GROUND a differential on an associative edge",
);
console.log("✓ associative `indicates` cannot ground (suggest-only)");

console.log("\nPASS — medical pack over kgraph");
process.exit(0);
