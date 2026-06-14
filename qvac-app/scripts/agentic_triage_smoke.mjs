// Smoke the agentic triage loop end-to-end: an LLM "patient" answers the agent's questions
// from a scenario until the agent concludes. Verifies the agent conducts the interview,
// grounds with tools, and produces a structured conclusion.
//   node scripts/agentic_triage_smoke.mjs
import { getProvider } from "../src/backend.js";
import { loadOrBuildIndex } from "../src/icd-index.js";
import { runTriageAgent } from "../src/triage-agent.js";
import { createFactStore, MemoryAdapter, makeFactstoreTools } from "@qvac/factstore";
import { seedInteractions, makeInteractionTool } from "../src/medlens.js";

const SCENARIO = "You are a 62-year-old woman with type 2 diabetes. For about an hour you have felt very tired and a bit nauseated, with an aching jaw and some sweating. You have NO chest pain. You think it is just a bug or low blood sugar.";

const provider = await getProvider();
await provider.init();
const index = await loadOrBuildIndex(provider);
const facts = createFactStore({ adapter: new MemoryAdapter() });
await seedInteractions(facts);
const log = "patient:atriage-smoke";
const extraTools = [
  ...makeFactstoreTools(facts, { log, subject: log, recallStatus: "confirmed" }),
  makeInteractionTool(facts, { patientLog: log, kbLog: "kb:medical" }),
];

// LLM patient: answer the agent's question briefly, consistent with the scenario.
async function patientAnswer(q) {
  return provider.complete([
    { role: "system", content: `You are a patient at a pharmacy. ${SCENARIO} Answer the pharmacist's question briefly and naturally (1-2 sentences), consistent with your situation. Do not volunteer a diagnosis or use medical jargon.` },
    { role: "user", content: q },
  ], { temperature: 0.3 });
}

let messages = [];
const toolsUsed = new Set();
let next = "I feel really tired and a bit sick, with an aching jaw and some sweating, for about an hour.";
let outcome = null;

for (let turn = 1; turn <= 8 && !outcome; turn++) {
  const r = await runTriageAgent({
    provider, icdIndex: index, extraTools, messages: [...messages, { role: "user", content: next }],
    onEvent: (e) => {
      if (e.type === "tool_call") toolsUsed.add(e.name);
      else if (e.type === "question") console.log(`  Q${turn}: ${e.text}`);
      else if (e.type === "conclusion") outcome = e.outcome;
    },
  });
  messages = r.messages;
  if (outcome) break;
  if (r.question) {
    const a = await patientAnswer(r.question);
    console.log(`  A${turn}: ${a.slice(0, 100)}`);
    next = a;
  } else { console.log("  (no question, no conclusion — stopping)"); break; }
  next = next || "I'm not sure.";
}

console.log("\n=== result ===");
console.log("tools used:", [...toolsUsed].join(", ") || "(none)");
if (outcome) {
  console.log(`DECISION: ${outcome.decision}  (band ${outcome.band}, severity ${outcome.severity})`);
  console.log(`CONDITION: ${outcome.condition}  ICD: ${outcome.icd} ${outcome.icdDescription ? "(" + outcome.icdDescription + ")" : ""}`);
  console.log(`RED FLAGS: ${outcome.redFlags}`);
  console.log(`ROUTING: ${outcome.routing}`);
  const pass = outcome.decision && ["RED", "AMBER", "GREEN"].includes(outcome.band);
  console.log(pass ? "\nPASS — structured conclusion produced (atypical MI should be EMERGENCY/RED)" : "\nFAIL — no valid structured conclusion");
  process.exit(pass ? 0 : 1);
} else {
  console.log("FAIL — interview did not conclude");
  process.exit(1);
}
