// Kiosk acceptance matrix — a broad, DETERMINISTIC test across the three kiosk surfaces (no
// model, no network), driven by scripts/kiosk-scenarios.mjs. Repeatable and fast, so it can gate
// every change. Three sections: the safety-review gate, federated pharmacovigilance signals, and
// the edge-learning federation lifecycle. Exits non-zero if any case fails.
//   node scripts/kiosk_matrix.mjs
import { createFactStore, MemoryAdapter } from "@qvac/factstore";
import { runTriageAgent } from "../src/triage-agent.js";
import { observeCooccurrence, aggregateSignals, detectSignals, autoProposeSignals, pairKey } from "../src/signals.js";
import { proposeEdge, recordVote, promoteEdge, rejectEdge, pendingEdges, sanitizeNote, noteLooksPersonal } from "../src/edge-learning.js";
import { seedInteractions, screenInteractions, drugId } from "../src/medlens.js";
import { memberOf, isCountableVote } from "../src/membership.js";
import { GATE_SCENARIOS, SIGNAL_SCENARIOS, FED_EDGES } from "./kiosk-scenarios.mjs";

const C = { ok: "\x1b[32m", no: "\x1b[31m", dim: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const results = { gate: [], signal: [], fed: [], privacy: [] };
const BAND = { EMERGENCY: "RED", URGENT: "AMBER", "PHARMACIST-LED": "GREEN", ROUTINE: "GREEN", "INSUFFICIENT-DATA": "AMBER" };
const rec = (sec, id, pass, detail) => { results[sec].push({ id, pass, detail }); console.log(`  ${pass ? C.ok + "✓" : C.no + "✗"} ${id}${C.x}${detail ? C.dim + " — " + detail + C.x : ""}`); };

// ── Section 1: safety-gate matrix ────────────────────────────────────────────────────────────
// A stub provider concludes immediately with the scenario's agent args, and returns the scenario's
// supervisor verdict from complete(). icdIndex is null so verifyIcd is caught (model-free).
function gateStub(agentArgs, verdict) {
  const verdictResponse = verdict === "GARBAGE" ? "the reviewer is offline — no json here" : JSON.stringify(verdict);
  const stub = {
    name: "stub", lastPrompt: "",
    async chatWithTools() { return { content: "", toolCalls: [{ id: "c1", function: { name: "conclude", arguments: JSON.stringify(agentArgs) } }] }; },
    async complete(messages) { stub.lastPrompt = (messages || []).map((m) => m.content).join("\n"); return verdictResponse; }, // capture the supervisor prompt
    async embed() { return []; },
  };
  return stub;
}

async function runGate() {
  console.log(`\n${C.b}[1] Safety-gate matrix${C.x} — ${GATE_SCENARIOS.length} clinical × decision-tree cases`);
  for (const s of GATE_SCENARIOS) {
    const provider = gateStub(s.agent, s.verdict);
    const consultFn = s.consult ? async () => s.consult : null;
    let r;
    try {
      r = await runTriageAgent({
        provider, icdIndex: null, messages: [{ role: "user", content: s.complaint }], retries: 0,
        supervisorAsksLeft: s.reaskLeft ?? 1, consultFn,
      });
    } catch (e) { rec("gate", s.id, false, `threw: ${e?.message || e}`); continue; }

    const e = s.expect;
    if (e.ask) {
      // a follow-up must be returned (not concluded) AND be the supervisor's exact question.
      const pass = r.supervisorAsk === true && !r.outcome && r.question === s.verdict.askInstead;
      rec("gate", `${s.category}/${s.id}`, pass, pass ? `asked: "${(r.question || "").slice(0, 44)}…"` : `expected follow-up "${s.verdict.askInstead?.slice(0, 30)}…", got ${r.question ? `q="${r.question.slice(0, 30)}"` : r.outcome?.decision || "?"}`);
      continue;
    }
    const o = r.outcome || {};
    const decOk = o.decision === e.decision;
    const escOk = (o.supervised?.escalated ?? false) === !!e.escalated;
    const conOk = !!o.consult === !!e.consult;
    const bandOk = o.band === BAND[e.decision]; // the RED/AMBER/GREEN the kiosk shows
    const pass = decOk && escOk && conOk && bandOk;
    const got = `${o.decision}/${o.band}${o.supervised?.escalated ? " esc" : ""}${o.consult ? " +peer" : ""}`;
    rec("gate", `${s.category}/${s.id}`, pass, pass ? got : `want ${e.decision}/${BAND[e.decision]}${e.escalated ? " esc" : ""}${e.consult ? " +peer" : ""}, got ${got}`);
  }

  // evidence integrity: the supervisor must actually SEE the gathered evidence + the proposed
  // conclusion (validates summarizeEvidence + prompt construction — the PHI-bearing local surface).
  const s0 = GATE_SCENARIOS[0];
  const cap = gateStub(s0.agent, s0.verdict);
  await runTriageAgent({ provider: cap, icdIndex: null, messages: [{ role: "user", content: s0.complaint }], retries: 0, supervisorAsksLeft: 1 });
  const p = cap.lastPrompt || "";
  const evOk = p.includes(s0.complaint.slice(0, 24)) && /Proposed conclusion/.test(p) && p.includes(s0.agent.decision);
  rec("gate", "evidence-recap", evOk, evOk ? "supervisor sees patient evidence + proposed conclusion" : "evidence or conclusion missing from supervisor prompt");
}

// ── Section 2: signal threshold matrix ───────────────────────────────────────────────────────
async function runSignals() {
  console.log(`\n${C.b}[2] Federated-signal matrix${C.x} — ${SIGNAL_SCENARIOS.length} threshold edge cases`);
  for (const s of SIGNAL_SCENARIOS) {
    const store = createFactStore({ adapter: new MemoryAdapter() });
    const logs = new Set();
    for (const [kiosk, a, b, adverse, times, contributor] of s.obs) {
      const log = `kb:${kiosk}`; logs.add(log);            // log = a replicated core; `by` = who authored the tally
      for (let i = 0; i < times; i++) await observeCooccurrence(store, { a, b, adverse, by: contributor || kiosk, log });
    }
    const rows = await aggregateSignals(store, { logs: [...logs] });
    const known = new Set((s.known || []).map(([a, b]) => pairKey(a, b)));
    const crossing = detectSignals(rows, { knownPairs: known });
    const gotPairs = new Set(crossing.map((r) => r.pairKey));
    const wantPairs = new Set((s.cross || []).map(([a, b]) => pairKey(a, b)));
    let pass = gotPairs.size === wantPairs.size && [...wantPairs].every((p) => gotPairs.has(p));
    let detail = `crossing: ${[...gotPairs].map((p) => p.replace(/drug:/g, "")).join(", ") || "none"}`;
    if (pass && s.assertAgg) {
      const pk = pairKey(s.assertAgg.a, s.assertAgg.b);
      const row = rows.find((r) => r.pairKey === pk);
      const aggOk = row && row.seen === s.assertAgg.seen && row.flagged === s.assertAgg.flagged && row.contributors === s.assertAgg.contributors;
      if (!aggOk) { pass = false; detail = `agg mismatch: got seen=${row?.seen} flagged=${row?.flagged} contrib=${row?.contributors}, want ${JSON.stringify(s.assertAgg)}`; }
      else detail += ` · agg ${row.flagged}/${row.seen} ×${row.contributors}`;
    }
    rec("signal", s.id, pass, detail);
  }

  // autoProposeSignals: severity is heuristic from the flagged rate (≥0.6 major, ≥0.4 moderate,
  // else minor), and it routes through the real proposeEdge (lands a candidate, never grounds).
  const store = createFactStore({ adapter: new MemoryAdapter() });
  const crossing = [
    { a: "drug:aa", b: "drug:bb", seen: 10, flagged: 7, contributors: 2, rate: 0.7 },
    { a: "drug:cc", b: "drug:dd", seen: 10, flagged: 5, contributors: 2, rate: 0.5 },
    { a: "drug:ee", b: "drug:ff", seen: 10, flagged: 3, contributors: 2, rate: 0.3 },
  ];
  const proposed = await autoProposeSignals(crossing, (ed) => proposeEdge(store, { ...ed }), { meId: "m" });
  const sev = Object.fromEntries(proposed.map((x) => [x.a, x.severity]));
  const sevOk = proposed.length === 3 && sev["drug:aa"] === "major" && sev["drug:cc"] === "moderate" && sev["drug:ee"] === "minor";
  rec("signal", "autopropose-severity", sevOk, JSON.stringify(sev));
}

// ── Section 3: federation lifecycle ──────────────────────────────────────────────────────────
// Mirrors the server's mergePeerGraph: pull a peer's interaction edges into a local store,
// asserting only new/changed ones (sig = object + proposed + severity + confidence).
async function simulateMerge(fromStore, toStore) {
  const [peer, local] = await Promise.all([
    fromStore.fold("kb:medical", { predicate: "interacts_with" }).then((r) => r.facts),
    toStore.fold("kb:medical", { predicate: "interacts_with" }).then((r) => r.facts),
  ]);
  const sig = (f) => JSON.stringify([f.object, f.meta?.proposed, f.meta?.severity, f.confidence]);
  const localById = new Map(local.map((f) => [f.statementId, sig(f)]));
  let merged = 0;
  for (const f of peer) {
    if (localById.get(f.statementId) === sig(f)) continue;
    await toStore.assert("kb:medical", { statementId: f.statementId, subject: f.subject, predicate: "interacts_with", object: f.object, source: f.source || "peer", confidence: f.confidence, meta: f.meta });
    merged++;
  }
  return merged;
}
const freshKb = async () => { const s = createFactStore({ adapter: new MemoryAdapter() }); await seedInteractions(s); return s; };
const patientOn = async (drug) => { const p = createFactStore({ adapter: new MemoryAdapter() }); await p.assert("patient:t", { subject: "patient:t", predicate: "takes", object: { ref: drugId(drug) }, source: "intake" }); return p; };
const grounds = async (kb, a, b) => { const p = await patientOn(a); return (await screenInteractions(p, { patientLog: "patient:t", candidate: b, kbStore: kb })).length; };

async function runFederation() {
  console.log(`\n${C.b}[3] Federation lifecycle${C.x} — dedup · grounding · transitive · conflict · votes · membership`);
  const E = FED_EDGES[0]; // fluconazole + phenytoin

  // (a) dedup — proposing the same pair twice yields ONE candidate.
  { const kb = await freshKb();
    await proposeEdge(kb, { ...E });
    const second = await proposeEdge(kb, { ...E });
    const pend = (await pendingEdges(kb)).filter((p) => p.a === drugId(E.a) || p.a === drugId(E.b));
    rec("fed", "dedup", second.existing === true && pend.length === 1, `existing=${second.existing}, pending=${pend.length}`); }

  // (b) a candidate does NOT ground; once promoted it DOES (both directions).
  { const kb = await freshKb();
    const r = await proposeEdge(kb, { ...E });
    const before = await grounds(kb, E.a, E.b);
    await promoteEdge(kb, r.id, { by: "clinician" });
    const afterFwd = await grounds(kb, E.a, E.b);
    const afterRev = await grounds(kb, E.b, E.a);
    rec("fed", "candidate-vs-promoted", before === 0 && afterFwd === 1 && afterRev === 1, `candidate=${before} promoted fwd=${afterFwd} rev=${afterRev}`); }

  // (c) transitive A→B→C: promote on A, merge A→B then B→C; C must ground it.
  { const A = await freshKb(), B = await freshKb(), Cc = await freshKb();
    const r = await proposeEdge(A, { ...E }); await promoteEdge(A, r.id, { by: "clinician" });
    await simulateMerge(A, B); await simulateMerge(B, Cc);
    const cGrounds = await grounds(Cc, E.a, E.b);
    rec("fed", "transitive-3-node", cGrounds === 1, `C grounds=${cGrounds}`); }

  // (d) conflicting severity: B holds a moderate CANDIDATE; A's PROMOTED major merges in and wins.
  { const A = await freshKb(), B = await freshKb();
    const ra = await proposeEdge(A, { ...E, severity: "major" }); await promoteEdge(A, ra.id, { by: "clinician", severity: "major" });
    await proposeEdge(B, { ...E, severity: "moderate" }); // B's local candidate
    await simulateMerge(A, B);
    const e = (await B.fold("kb:medical", { predicate: "interacts_with" })).facts.find((f) => f.statementId === ra.id);
    const bGrounds = await grounds(B, E.a, E.b);
    rec("fed", "conflict-promoted-wins", bGrounds === 1 && e?.meta?.proposed === false && e?.meta?.severity === "major", `grounds=${bGrounds} severity=${e?.meta?.severity} proposed=${e?.meta?.proposed}`); }

  // (e) membership predicate — the REAL src/membership.js the server enforces (not a copy).
  { const members = new Set(["puba", "pubb"]); const myPub = "self";
    const openOk = memberOf(null, myPub, "anyone") === true;                 // open mesh → all
    const selfOk = memberOf(members, myPub, "self") === true;                // this device
    const memOk = memberOf(members, myPub, "PubA") === true;                 // allowlisted (case-insensitive)
    const outOk = memberOf(members, myPub, "stranger") === false;            // not a member → rejected
    rec("fed", "membership-predicate", openOk && selfOk && memOk && outOk, `open=${openOk} self=${selfOk} member=${memOk} reject=${outOk}`); }

  // (f) jury vote filter — the REAL isCountableVote: only SIGNED votes from MEMBERS count.
  { const isMember = (p) => p === "pubA" || p === "pubB";
    const counted = [
      { peer: { publicKey: "pubA" }, signatureOk: true },   // ✓
      { peer: { publicKey: "pubB" }, signatureOk: true },   // ✓
      { peer: { publicKey: "pubX" }, signatureOk: true },   // ✗ non-member
      { peer: { publicKey: "pubA" }, signatureOk: false },  // ✗ unsigned
    ].filter((v) => isCountableVote(v, isMember));
    rec("fed", "vote-filter", counted.length === 2 && counted.every((v) => isMember(v.peer.publicKey) && v.signatureOk), `counted=${counted.length}/4`); }

  // (g) recordVote dedup — one vote per voter; a re-vote REPLACES (no tally inflation).
  { const kb = await freshKb();
    const r = await proposeEdge(kb, { ...E });
    await recordVote(kb, r.id, { voter: "pubA", real: true });
    await recordVote(kb, r.id, { voter: "pubB", real: true });
    await recordVote(kb, r.id, { voter: "pubA", real: false }); // re-vote replaces pubA
    const votes = (await pendingEdges(kb)).find((p) => p.id === r.id)?.votes || [];
    const byVoter = Object.fromEntries(votes.map((v) => [v.voter, v.real]));
    rec("fed", "recordVote-dedup", votes.length === 2 && byVoter.pubA === false && byVoter.pubB === true, `${JSON.stringify(byVoter)}`); }

  // (h) reject retracts a candidate — never grounds, drops from pending.
  { const kb = await freshKb();
    const r = await proposeEdge(kb, { ...E });
    await rejectEdge(kb, r.id);
    const g = await grounds(kb, E.a, E.b);
    const stillPending = (await pendingEdges(kb)).some((p) => p.id === r.id);
    rec("fed", "reject-retracts", g === 0 && !stillPending, `grounds=${g} pending=${stillPending}`); }
}

// ── Section 4: privacy / PHI scrub ───────────────────────────────────────────────────────────
// sanitizeNote is the de-identification backstop for the ONE free-text field that leaves a device
// (a learned-edge note). It must strip stray patient identifiers while keeping clinical content;
// noteLooksPersonal flags residual references for the human reviewer.
function runPrivacy() {
  console.log(`\n${C.b}[4] Privacy / PHI scrub${C.x} — sanitizeNote (the field that crosses the mesh) + noteLooksPersonal`);
  const cases = [
    { id: "strip-name-age", in: "Mr John Smith, 72yo, reacted to warfarin", strip: ["John Smith", "72"], keep: ["warfarin"] },
    { id: "strip-dob-email-mrn", in: "DOB 12/03/1950, email a.b@x.com, MRN 1234567 on simvastatin", strip: ["12/03/1950", "a.b@x.com", "1234567"], keep: ["simvastatin"] },
    { id: "keep-clinical", in: "CYP2C9 inhibition raises INR; typical 5mg dose, code J18.9", strip: [], keep: ["CYP2C9", "INR", "5mg", "J18.9"] },
  ];
  for (const c of cases) {
    const out = sanitizeNote(c.in);
    const stripped = c.strip.every((s) => !out.includes(s));
    const kept = c.keep.every((k) => out.includes(k));
    rec("privacy", c.id, stripped && kept, stripped && kept ? `→ "${out}"` : `leak/loss → "${out}"`);
  }
  const flagOk = noteLooksPersonal("the patient mentioned chest pain") === true && noteLooksPersonal("CYP3A4 inhibition raises exposure") === false;
  rec("privacy", "flag-residual-personal", flagOk, flagOk ? "flags 'the patient', clears clinical prose" : "mis-flag");
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
await runGate();
await runSignals();
await runFederation();
runPrivacy();

const sum = (sec) => { const r = results[sec]; return `${r.filter((x) => x.pass).length}/${r.length}`; };
const allPass = Object.values(results).every((r) => r.every((x) => x.pass));
console.log(`\n${C.b}── summary ──${C.x}`);
console.log(`  gate    ${sum("gate")}`);
console.log(`  signals ${sum("signal")}`);
console.log(`  fed     ${sum("fed")}`);
console.log(`  privacy ${sum("privacy")}`);
const failed = Object.entries(results).flatMap(([s, r]) => r.filter((x) => !x.pass).map((x) => `${s}/${x.id}`));
console.log(`\n${allPass ? C.ok + C.b + "PASS" : C.no + C.b + "FAIL"}${C.x} — ${Object.values(results).flat().filter((x) => x.pass).length}/${Object.values(results).flat().length} cases${failed.length ? " · failed: " + failed.join(", ") : ""}`);
process.exit(allPass ? 0 : 1);
