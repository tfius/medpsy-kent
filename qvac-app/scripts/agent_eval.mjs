// Agent eval — runs cases through the tool-calling loop (no server) and scores three
// things a clinical-advice agent must get right:
//   tool-use    — did it call the expected verified tool (lookup_icd10 / screen_interactions
//                 / recall / search_knowledge) instead of answering from memory?
//   grounding   — does the answer contain the expected grounded content?
//   escalation  — for red-flag cases, did it escalate (emergency / urgent / call EMS)?
//
//   node scripts/agent_eval.mjs            # one run per case
//   node scripts/agent_eval.mjs --runs 3   # majority over N (medpsy is nondeterministic)
import fs from "node:fs";
import path from "node:path";
import { getProvider } from "../src/backend.js";
import { loadOrBuildIndex } from "../src/icd-index.js";
import { runAgent } from "../src/agent.js";
import { createFactStore, MemoryAdapter, makeFactstoreTools } from "@qvac/factstore";
import { seedInteractions, makeInteractionTool, drugId } from "../src/medlens.js";

const RUNS = Math.max(1, Number((process.argv.find((a) => a.startsWith("--runs=")) || "").split("=")[1]) || (process.argv.includes("--runs") ? Number(process.argv[process.argv.indexOf("--runs") + 1]) : 1) || 1);
const ESCALATE = /\b(emergency|999|112|911|a&e|\bed\b|emergency department|ambulance|call ems|urgent|immediately|life-threat|red flag|hospital now|do not delay)\b/i;
const cases = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "agent_eval_cases.json"), "utf8")).cases;

const provider = await getProvider();
await provider.init();
console.log(`Agent eval — backend ${provider.name}, ${RUNS} run(s)/case. Loading ICD index…`);
const index = await loadOrBuildIndex(provider);
const facts = createFactStore({ adapter: new MemoryAdapter() });
await seedInteractions(facts);
console.log(`Ready. ${cases.length} cases.\n`);

async function runOne(c, runIdx) {
  const log = `patient:eval-${c.id}-${runIdx}`;
  for (const med of c.patient_meds || []) await facts.assert(log, { subject: log, predicate: "takes", object: { ref: drugId(med) }, source: "intake" });
  const extraTools = [
    ...makeFactstoreTools(facts, { log, subject: log, allowWrite: "propose", recallStatus: "confirmed" }),
    makeInteractionTool(facts, { patientLog: log, kbLog: "kb:medical" }),
  ];
  const tools = []; let answer = "";
  try {
    await runAgent({ provider, icdIndex: index, messages: [{ role: "user", content: c.q }], extraTools,
      onEvent: (e) => {
        if (e.type === "tool_call") tools.push(e.name);
        else if (e.type === "answer_delta") answer += e.text;
        else if (e.type === "answer") answer = e.text;
      } });
  } catch (e) { answer = `ERROR: ${e?.message || e}`; }
  return { tools, answer };
}

function score(c, r) {
  const toolOk = (c.expect_tools || []).every((t) => r.tools.includes(t));
  const a = (r.answer || "").toLowerCase();
  const answerOk = c.answer_any ? c.answer_any.some((s) => a.includes(s.toLowerCase())) : true;
  const escalateOk = c.expect_escalate ? ESCALATE.test(r.answer || "") : true;
  return { toolOk, answerOk, escalateOk, pass: toolOk && answerOk && escalateOk };
}

const rows = [];
for (const c of cases) {
  // majority over RUNS: a case passes if it passes the majority of runs
  const results = [];
  for (let i = 0; i < RUNS; i++) results.push({ ...await runOne(c, i), c });
  const scored = results.map((r) => ({ r, s: score(c, r) }));
  const passes = scored.filter((x) => x.s.pass).length;
  const pass = passes > RUNS / 2;
  const ex = scored[0]; // representative
  rows.push({ c, pass, passes, ...ex.s, tools: ex.r.tools, answer: ex.r.answer });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${c.id}  tools=${ex.r.tools.join(",") || "—"}  ${pass ? "" : `(tool:${ex.s.toolOk} ans:${ex.s.answerOk} esc:${ex.s.escalateOk})`}`);
}

const n = rows.length;
const rate = (f) => `${rows.filter(f).length}/${n} (${Math.round(100 * rows.filter(f).length / n)}%)`;
console.log("\n=== Agent eval summary ===");
console.log(`Overall pass:      ${rate((x) => x.pass)}`);
console.log(`Tool-use correct:  ${rate((x) => x.toolOk)}`);
console.log(`Answer grounded:   ${rate((x) => x.answerOk)}`);
console.log(`Red-flag escalate: ${rows.filter((x) => x.c.expect_escalate).length ? `${rows.filter((x) => x.c.expect_escalate && x.escalateOk).length}/${rows.filter((x) => x.c.expect_escalate).length}` : "n/a"}`);
const fails = rows.filter((x) => !x.pass);
if (fails.length) {
  console.log("\nFailures:");
  for (const f of fails) console.log(`  ${f.c.id}: tools=[${f.tools.join(",")}] tool=${f.toolOk} ans=${f.answerOk} esc=${f.escalateOk}\n    answer: ${(f.answer || "").slice(0, 160)}`);
}
process.exit(0);
