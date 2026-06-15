// Autonomous-agent safety-gate smoke — proves the supervised conclusion: an INDEPENDENT
// supervisor pass re-reads the evidence and may overrule the agent's conclusion, but ONLY to
// make it safer. Deterministic (a stub provider; no model/network), so it's a real assertion.
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

async function run(label, complaint, concludeArgs, verdictJson) {
  const provider = stub(concludeArgs, verdictJson);
  let critique = null;
  const r = await runTriageAgent({
    provider, icdIndex: null, messages: [{ role: "user", content: complaint }],
    onEvent: (e) => { if (e.type === "critique") critique = e.verdict; }, retries: 0,
  });
  const o = r.outcome;
  console.log(`\n[${label}] agent said ${concludeArgs.decision}(${concludeArgs.severity}) → final ${o.decision}(${o.severity}) band=${o.band} escalated=${o.supervised?.escalated}`);
  if (o.supervised?.escalated) console.log(`   safety review: ${o.supervised.rationale}  (was ${o.supervised.from})`);
  return o;
}

// 1) UNDER-TRIAGE caught: agent says ROUTINE for cardiac-sounding chest pain → supervisor escalates.
const a = await run("under-triage → escalate", "central chest pain radiating to left arm, sweaty",
  { decision: "ROUTINE", severity: 2, condition: "muscle strain", icd: "M79.1", redFlags: "none identified", routing: "self-care", safetyNet: "return if worse" },
  JSON.stringify({ agree: false, decision: "EMERGENCY", severity: 9, missedRedFlags: "cardiac chest pain — possible ACS", rationale: "radiating chest pain + diaphoresis is ACS until proven otherwise" }));

// 2) APPROPRIATE: agent says PHARMACIST-LED for a mild sore throat → supervisor agrees, unchanged.
const b = await run("appropriate → unchanged", "mild sore throat for a day, no fever",
  { decision: "PHARMACIST-LED", severity: 3, condition: "viral pharyngitis", icd: "J02.9", redFlags: "none identified", routing: "pharmacist advice", safetyNet: "return if breathing difficulty" },
  JSON.stringify({ agree: true, decision: "PHARMACIST-LED", severity: 3, missedRedFlags: "none", rationale: "appropriate" }));

// 3) SAFETY-BIAS: supervisor must NOT be able to DE-escalate a genuine emergency.
const c = await run("cannot de-escalate", "anaphylaxis — swelling, can't breathe",
  { decision: "EMERGENCY", severity: 10, condition: "anaphylaxis", icd: "T78.2", redFlags: "airway compromise", routing: "999", safetyNet: "call emergency services now" },
  JSON.stringify({ agree: false, decision: "ROUTINE", severity: 1, missedRedFlags: "none", rationale: "looks mild" }));

const pass =
  a.decision === "EMERGENCY" && a.band === "RED" && a.supervised?.escalated === true && /Safety review/.test(a.routing) &&
  b.decision === "PHARMACIST-LED" && b.supervised?.escalated === false &&
  c.decision === "EMERGENCY" && c.supervised?.escalated === false; // de-escalation refused

console.log(`\n${pass ? "PASS" : "FAIL"} — under-triage escalated (${a.supervised?.escalated}), appropriate untouched (${!b.supervised?.escalated}), de-escalation refused (${!c.supervised?.escalated})`);
process.exit(pass ? 0 : 1);
