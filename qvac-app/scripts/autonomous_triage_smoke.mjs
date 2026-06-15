// Autonomous-agent safety-gate smoke — proves the supervised conclusion end to end, deterministically
// (a stub provider; no model/network), so it's a real assertion. Covers:
//   - self-correction: an independent supervisor may overrule the conclusion, but only SAFER;
//   - follow-up: a plausible-but-unconfirmed red flag becomes ONE more patient question (bounded);
//   - peer consult: on an uncertain case the gate fetches a peer second opinion that can only RAISE.
//   node scripts/autonomous_triage_smoke.mjs
import { runTriageAgent } from "../src/triage-agent.js";

// A provider that (a) immediately concludes with `concludeArgs` (no questions/tools), and (b)
// returns `verdictJson` as the supervisor's review. icdIndex is null → verifyIcd is caught and
// the agent's guess is kept, so the test is model-free.
function stub(concludeArgs, verdictJson) {
  return {
    name: "stub",
    async chatWithTools() { return { content: "", toolCalls: [{ id: "c1", function: { name: "conclude", arguments: JSON.stringify(concludeArgs) } }] }; },
    async complete() { return verdictJson; },
    async embed() { return []; },
  };
}

async function run(label, complaint, concludeArgs, verdictJson, { supervisorAsksLeft = 1, consultFn = null } = {}) {
  const provider = stub(concludeArgs, verdictJson);
  let critique = null, consultEv = null;
  const r = await runTriageAgent({
    provider, icdIndex: null, messages: [{ role: "user", content: complaint }], retries: 0,
    supervisorAsksLeft, consultFn,
    onEvent: (e) => { if (e.type === "critique") critique = e.verdict; else if (e.type === "consult") consultEv = e.consult; },
  });
  if (r.supervisorAsk) console.log(`\n[${label}] → SAFETY REVIEW ASKED ONE MORE QUESTION: "${r.question}"`);
  else { const o = r.outcome; console.log(`\n[${label}] agent ${concludeArgs.decision}(${concludeArgs.severity}) → final ${o.decision}(${o.severity}) band=${o.band} escalated=${o.supervised?.escalated}${o.consult ? ` consult=${o.consult.peer}` : ""}`); }
  return { r, critique, consultEv };
}

// 1) UNDER-TRIAGE caught → escalate (no follow-up offered).
const a = (await run("under-triage → escalate", "central chest pain radiating to left arm, sweaty",
  { decision: "ROUTINE", severity: 2, condition: "muscle strain", icd: "M79.1", redFlags: "none identified", routing: "self-care", safetyNet: "return if worse" },
  JSON.stringify({ agree: false, decision: "EMERGENCY", severity: 9, missedRedFlags: "possible ACS", rationale: "radiating chest pain + diaphoresis is ACS until proven otherwise" }))).r;

// 2) APPROPRIATE → unchanged.
const b = (await run("appropriate → unchanged", "mild sore throat for a day, no fever",
  { decision: "PHARMACIST-LED", severity: 3, condition: "viral pharyngitis", icd: "J02.9", redFlags: "none identified", routing: "pharmacist advice", safetyNet: "return if breathing difficulty" },
  JSON.stringify({ agree: true, decision: "PHARMACIST-LED", severity: 3, missedRedFlags: "none", rationale: "appropriate" }))).r;

// 3) SAFETY-BIAS: supervisor cannot DE-escalate a real emergency.
const c = (await run("cannot de-escalate", "anaphylaxis — swelling, can't breathe",
  { decision: "EMERGENCY", severity: 10, condition: "anaphylaxis", icd: "T78.2", redFlags: "airway compromise", routing: "999", safetyNet: "call emergency services now" },
  JSON.stringify({ agree: false, decision: "ROUTINE", severity: 1, missedRedFlags: "none", rationale: "looks mild" }))).r;

// 4) FOLLOW-UP: plausible red flag + budget → ask one more question instead of concluding.
const dArgs = { decision: "ROUTINE", severity: 3, condition: "headache", icd: "R51", redFlags: "none identified", routing: "self-care", safetyNet: "return if worse" };
const dVerdict = JSON.stringify({ agree: false, decision: "URGENT", severity: 6, missedRedFlags: "possible thunderclap", askInstead: "Did this headache come on suddenly and peak within seconds?", rationale: "sudden-onset would suggest SAH" });
const d = (await run("plausible flag → follow-up", "headache since this morning", dArgs, dVerdict, { supervisorAsksLeft: 1 })).r;

// 5) BUDGET EXHAUSTED: same case, no budget → must NOT re-ask; escalate instead.
const e = (await run("no budget → escalate", "headache since this morning", dArgs, dVerdict, { supervisorAsksLeft: 0 })).r;

// 6) PEER CONSULT: an uncertain (INSUFFICIENT-DATA) case → fetch a peer opinion that escalates.
const consultFn = async () => ({ answer: "ESCALATE — guarding suggests peritonism; do not send home.", peer: "Dr-B", signatureOk: true, escalate: true });
const f = (await run("uncertain → peer escalates", "vague tummy ache",
  { decision: "INSUFFICIENT-DATA", severity: 5, condition: "abdominal pain, unclear", icd: "R10.9", redFlags: "none identified", routing: "pharmacist review", safetyNet: "return if worse" },
  JSON.stringify({ agree: true, decision: "INSUFFICIENT-DATA", severity: 5, missedRedFlags: "none", rationale: "insufficient information" }),
  { consultFn })).r;

const pass =
  a.outcome?.decision === "EMERGENCY" && a.outcome?.band === "RED" && a.outcome?.supervised?.escalated === true && !a.supervisorAsk &&
  b.outcome?.decision === "PHARMACIST-LED" && b.outcome?.supervised?.escalated === false &&
  c.outcome?.decision === "EMERGENCY" && c.outcome?.supervised?.escalated === false &&
  d.supervisorAsk === true && /suddenly/.test(d.question || "") && !d.outcome &&
  e.supervisorAsk !== true && e.outcome?.decision === "URGENT" &&
  f.outcome?.consult?.answer && f.outcome?.decision === "URGENT" && f.outcome?.consult?.signatureOk === true;

console.log(`\n${pass ? "PASS" : "FAIL"} — escalate(${a.outcome?.decision === "EMERGENCY"}) keep(${b.outcome?.supervised?.escalated === false}) no-deescalate(${c.outcome?.decision === "EMERGENCY"}) follow-up(${d.supervisorAsk === true}) budget(${e.outcome?.decision === "URGENT"}) peer-raises(${f.outcome?.decision === "URGENT"})`);
process.exit(pass ? 0 : 1);
