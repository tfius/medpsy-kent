// QVAC tool-loop smoke — verifies the agent's multi-turn tool round-trip works against the
// LIVE @qvac/sdk (gemma4 dialect): a tool_call turn → role:"tool" result fed back → a final
// grounded answer. This is the round-trip qvac.js flagged as "verify against the live SDK".
//   MEDPSY_BACKEND=qvac node scripts/qvac_agent_smoke.mjs
process.env.MEDPSY_BACKEND = "qvac";
const { getProvider } = await import("../src/backend.js");
const { loadOrBuildIndex } = await import("../src/icd-index.js");
const { runAgent } = await import("../src/agent.js");

const t0 = Date.now();
const provider = await getProvider();
await provider.init();
console.log(`[qvac-smoke] backend ${provider.name} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s; building ICD index…`);
const index = await loadOrBuildIndex(provider);
console.log(`[qvac-smoke] index ready (${((Date.now() - t0) / 1000).toFixed(1)}s). Asking a tool-requiring question…`);

const tools = [];
let answer = "", reasoning = "";
const tq = Date.now();
await runAgent({
  provider, icdIndex: index,
  messages: [{ role: "user", content: "What is the verified ICD-10 code for community-acquired pneumonia? Use your lookup tool, don't guess." }],
  onEvent: (e) => {
    if (e.type === "tool_call") { tools.push(e.name); console.log(`  → tool_call: ${e.name}(${JSON.stringify(e.args).slice(0, 80)})`); }
    else if (e.type === "tool_result") console.log(`  ← tool_result: ${JSON.stringify(e.result).slice(0, 100)}`);
    else if (e.type === "answer_delta") answer += e.text;
    else if (e.type === "answer") answer = e.text;
    else if (e.type === "reasoning") reasoning = e.text;
  },
});

console.log(`\n=== result (${((Date.now() - tq) / 1000).toFixed(1)}s) ===`);
console.log("tools called:", tools.length ? tools.join(", ") : "(none)");
console.log("answer:", (answer || "").slice(0, 300));
const toolOk = tools.includes("lookup_icd10");
const groundOk = /J1[0-8]/.test(answer); // pneumonia codes J12–J18
console.log(`\n${toolOk && groundOk ? "PASS" : "FAIL"} — tool round-trip ${toolOk ? "OK" : "MISSING lookup_icd10"}, grounding ${groundOk ? "OK (J-code present)" : "no J-code in answer"}`);
await provider.close?.();
process.exit(toolOk && groundOk ? 0 : 1);
