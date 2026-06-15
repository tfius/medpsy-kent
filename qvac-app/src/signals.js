// Federated safety intelligence — PHI-free pharmacovigilance across the mesh.
//
// The edge-learning loop (src/edge-learning.js) federates a clinician's EXPLICIT correction.
// This federates an IMPLICIT signal: each kiosk quietly tallies, per drug PAIR seen together
// during triage, how often a concern was flagged — pure integer counts, never any patient
// data. A kiosk publishes only ITS OWN tallies as facts on the shared kb:medical graph
// (predicate "cooccurs_with", keyed by the kiosk's device pubkey) so they replicate to peers
// like any KB fact. Every kiosk then SUMS the tallies across contributors; when a pair's
// network aggregate crosses a threshold (enough distinct kiosks, enough flagged events, a high
// enough rate) it AUTO-PROPOSES a candidate interaction edge into the existing vet/promote loop
// — where a human pharmacist still vets and promotes before it EVER grounds.
//
// The magic: the network detects an emerging interaction that no single kiosk has enough data
// to see, with zero PHI leaving any device. A signal is just (drug, drug) + integer counts.
//
// Aggregation folds each peer log DIRECTLY (kb:medical for self + each replicated kb:peer:* log)
// rather than re-mirroring peers' tallies into our own core — so there's no transitive
// double-counting and no unbounded growth from re-asserting peers' numbers. Signal facts use
// predicate "cooccurs_with"; grounding/screening folds only "interacts_with", so a signal NEVER
// grounds on its own — it can only influence triage by surviving the human-gated promotion.
import { drugId } from "./medlens.js";

const KB = "kb:medical";
const PRED = "cooccurs_with";
const drugName = (id) => String(id).replace(/^drug:/, "");

// Canonical unordered pair key — "drug:a|drug:b" with the two ids sorted, so kiosks that see
// the pair in either order tally the same bucket. Returns null for a degenerate pair.
export function pairKey(a, b) {
  const [da, db] = [drugId(a), drugId(b)];
  if (!da || !db || da === db || da === "drug:" || db === "drug:") return null;
  return [da, db].sort().join("|");
}
const splitPair = (pk) => pk.split("|");
const sigId = (pub, pk) => `sig:${String(pub).slice(0, 12)}:${pk}`; // this kiosk's tally for this pair

// Serialize read-modify-write per store (mirrors edge-learning's withStoreLock) — observe reads
// the current tally then writes the incremented one, so two concurrent observes must not both
// read the old count and clobber each other (a lost increment).
const _locks = new WeakMap();
function withLock(store, fn) {
  const prev = _locks.get(store) || Promise.resolve();
  const run = prev.then(fn, fn);
  _locks.set(store, run.then(() => {}, () => {}));
  return run;
}

// Record that drugs `a` and `b` were seen together in a triage (adverse:true if a concern was
// flagged while both were present). Bumps THIS kiosk's de-identified tally for the pair and
// publishes it on kb:medical — PHI-free by construction (drug names + two integers, nothing else).
export async function observeCooccurrence(kbStore, { a, b, adverse = false, by, log = KB } = {}) {
  const pk = pairKey(a, b);
  if (!pk) throw new Error("two distinct drug names required");
  const me = String(by || "local");
  const id = sigId(me, pk);
  const [da, db] = splitPair(pk);
  return withLock(kbStore, async () => {
    const cur = (await kbStore.fold(log, { predicate: PRED })).facts.find((f) => f.statementId === id);
    const seen = (cur?.meta?.seen || 0) + 1;
    const flagged = (cur?.meta?.flagged || 0) + (adverse ? 1 : 0);
    const meta = { seen, flagged, contributor: me, updatedAt: new Date().toISOString(), signal: true };
    const fact = { statementId: id, subject: da, predicate: PRED, object: { ref: db }, source: "signal", confidence: 0, meta };
    if (cur) await kbStore.correct(log, id, { source: "signal", meta }).catch(() => kbStore.assert(log, fact));
    else await kbStore.assert(log, fact);
    return { pairKey: pk, a: da, b: db, seen, flagged, contributor: me };
  });
}

// Sum every kiosk's tallies across the given logs (self's kb:medical + each replicated peer
// log). Dedups by statementId keeping the freshest version (so a stale mirror can't undercount),
// then groups by pair and sums seen/flagged across DISTINCT contributors. Returns rows newest-rate
// first: { pairKey, a, b, seen, flagged, contributors, rate }.
export async function aggregateSignals(kbStore, { logs = [KB] } = {}) {
  const latest = new Map(); // statementId -> freshest signal fact
  for (const log of logs) {
    let facts = [];
    try { facts = (await kbStore.fold(log, { predicate: PRED })).facts; } catch { continue; }
    for (const f of facts) {
      if (!f.meta?.signal && f.source !== "signal") continue;
      const prev = latest.get(f.statementId);
      if (!prev || String(f.meta?.updatedAt || "") > String(prev.meta?.updatedAt || "")) latest.set(f.statementId, f);
    }
  }
  const byPair = new Map();
  for (const f of latest.values()) {
    const pk = [f.subject, f.object?.ref].sort().join("|");
    const row = byPair.get(pk) || { pairKey: pk, a: splitPair(pk)[0], b: splitPair(pk)[1], seen: 0, flagged: 0, contributors: new Set() };
    row.seen += f.meta?.seen || 0;
    row.flagged += f.meta?.flagged || 0;
    row.contributors.add(f.meta?.contributor || f.statementId.split(":")[1]);
    byPair.set(pk, row);
  }
  return [...byPair.values()]
    .map((r) => ({ pairKey: r.pairKey, a: r.a, b: r.b, seen: r.seen, flagged: r.flagged, contributors: r.contributors.size, rate: r.seen ? r.flagged / r.seen : 0 }))
    .sort((x, y) => y.rate - x.rate || y.flagged - x.flagged);
}

export const DEFAULT_THRESHOLD = { minContributors: 2, minFlagged: 3, minRate: 0.3 };

// Which aggregated pairs cross the safety threshold AND aren't already a known/proposed edge.
// minContributors >= 2 is the whole point: a signal must be seen by MORE THAN ONE kiosk before
// it's worth a human's attention — that's what makes it FEDERATED rather than one kiosk's noise.
export function detectSignals(rows, { knownPairs = new Set(), threshold = DEFAULT_THRESHOLD } = {}) {
  const t = { ...DEFAULT_THRESHOLD, ...threshold };
  return rows.filter((r) =>
    r.contributors >= t.minContributors &&
    r.flagged >= t.minFlagged &&
    r.rate >= t.minRate &&
    !knownPairs.has(r.pairKey));
}

// Turn a crossed signal into a candidate edge via the EXISTING propose path (proposeFn ===
// edge-learning.proposeEdge bound to the store). The note is a generalized, PHI-free summary of
// the aggregate; severity is heuristic from the flagged rate. A human still vets + promotes.
export async function autoProposeSignals(rows, proposeFn, { meId } = {}) {
  const proposed = [];
  for (const r of rows) {
    const severity = r.rate >= 0.6 ? "major" : r.rate >= 0.4 ? "moderate" : "minor";
    const note = `federated co-occurrence signal: ${r.flagged} concern(s) in ${r.seen} co-prescriptions across ${r.contributors} kiosks`;
    try {
      const res = await proposeFn({ a: drugName(r.a), b: drugName(r.b), severity, note, contributedBy: meId || "federated-signal", evidence: "federated-signal" });
      if (!res?.existing) proposed.push({ id: res.id, a: r.a, b: r.b, severity, seen: r.seen, flagged: r.flagged, contributors: r.contributors, rate: r.rate });
    } catch { /* already known / degenerate — skip */ }
  }
  return proposed;
}
