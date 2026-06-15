// Federated safety-intelligence smoke — proves PHI-free pharmacovigilance end to end (no model,
// no network): two kiosks each tally de-identified drug-pair co-occurrences; the aggregate sums
// ACROSS kiosks; a pair crosses the threshold ONLY because >1 kiosk saw it; the crossed signal
// auto-proposes a CANDIDATE into the human-gated vet/promote loop (it does NOT ground on its own).
//   node scripts/federated_signals_smoke.mjs
// (Two kiosks are simulated with two logs in one store — exactly how the server aggregates: it
//  folds self's kb:medical PLUS each replicated peer log. The live two-kiosk path is exercised by
//  the curl flow in JOURNAL.md / the Signals web view.)
import { createFactStore, MemoryAdapter } from "@qvac/factstore";
import { observeCooccurrence, aggregateSignals, detectSignals, autoProposeSignals, pairKey } from "../src/signals.js";
import { proposeEdge, pendingEdges } from "../src/edge-learning.js";
import { drugId } from "../src/medlens.js";

const SELF = "kb:medical", PEER = "kb:peer:other";
const A = "zalfadrug", B = "zbetadrug"; // synthetic — cannot collide with seeded interactions
const store = createFactStore({ adapter: new MemoryAdapter() });

// Kiosk-A (self) sees the pair 3x, 2 with a flagged concern.
await observeCooccurrence(store, { a: A, b: B, adverse: true, by: "kioskA", log: SELF });
await observeCooccurrence(store, { a: A, b: B, adverse: true, by: "kioskA", log: SELF });
await observeCooccurrence(store, { a: A, b: B, adverse: false, by: "kioskA", log: SELF });

// First: ONLY kiosk-A's data is present (1 contributor) — must NOT cross (federation requires >1).
let rows = await aggregateSignals(store, { logs: [SELF] });
const soloCross = detectSignals(rows, {});
console.log(`1) one kiosk only: aggregate seen=${rows[0]?.seen} flagged=${rows[0]?.flagged} contributors=${rows[0]?.contributors} → crossing=${soloCross.length} (should be 0)`);

// Kiosk-B (a replicated peer log) sees it 2x, both flagged.
await observeCooccurrence(store, { a: A, b: B, adverse: true, by: "kioskB", log: PEER });
await observeCooccurrence(store, { a: A, b: B, adverse: true, by: "kioskB", log: PEER });

// Now aggregate across BOTH logs (self + peer) — exactly what the server does.
rows = await aggregateSignals(store, { logs: [SELF, PEER] });
const r = rows[0];
console.log(`2) federated: aggregate seen=${r?.seen} flagged=${r?.flagged} contributors=${r?.contributors} rate=${r?.rate?.toFixed(2)}`);
const crossing = detectSignals(rows, {});
console.log(`3) crossing the threshold: ${crossing.length} (should be 1 — 2 kiosks, 4 flagged, rate 0.8)`);

// Already-known pairs are excluded (don't re-propose what's already an edge).
const known = new Set([pairKey(A, B)]);
console.log(`4) with the pair already known: crossing=${detectSignals(rows, { knownPairs: known }).length} (should be 0)`);

// Auto-propose the crossed signal into the existing vet/promote loop.
const proposed = await autoProposeSignals(crossing, (e) => proposeEdge(store, { ...e, log: SELF, evidence: "federated-signal" }), { meId: "kioskA" });
const pending = await pendingEdges(store);
const cand = pending.find((p) => p.a === drugId(A) || p.b === drugId(A));
console.log(`5) auto-proposed → pending candidate: ${cand ? `${cand.a}+${cand.b} sev=${cand.severity} "${cand.note}"` : "NONE"}`);
console.log(`   (candidate carries meta.proposed → it does NOT ground until a human promotes it)`);

const ok = soloCross.length === 0 && crossing.length === 1 && r?.contributors === 2 && r?.seen === 5 && r?.flagged === 4
  && detectSignals(rows, { knownPairs: known }).length === 0 && proposed.length === 1 && !!cand;
console.log(`\n${ok ? "PASS" : "FAIL"} — solo-doesn't-cross (${soloCross.length === 0}), federated-crosses (${crossing.length === 1}), known-excluded, auto-proposed (${proposed.length === 1})`);
process.exit(ok ? 0 : 1);
