// Can we get medpsy-4b to emit a PARSEABLE tool call under @qvac/sdk by instructing the
// format explicitly? Probe: an explicit JSON tool-call instruction + json dialect.
//   node scripts/qvac_dialect_probe.mjs
import { QVAC_LLM_GGUF } from "../src/config.js";
const { loadModel, completion } = await import("@qvac/sdk");

const llmId = await loadModel({ modelSrc: QVAC_LLM_GGUF, modelType: "llm" });
const tools = [{
  type: "function", name: "lookup_icd10", description: "Get the verified ICD-10 code for a condition.",
  parameters: { type: "object", properties: { condition: { type: "string", description: "the condition" } }, required: ["condition"] },
}];

const TOOL_INSTR = `You can call tools. Available tools:
- lookup_icd10(condition: string) — get the verified ICD-10 code for a condition.

When you need a tool, your ENTIRE reply must be a single JSON object and nothing else:
{"name": "<tool>", "arguments": { ... }}
Do not add prose. After you receive the tool result you will answer the user.`;

const history = [
  { role: "system", content: TOOL_INSTR },
  { role: "user", content: "Get the ICD-10 code for community-acquired pneumonia." },
];

for (const dialect of ["json", "hermes", "gemma4"]) {
  const run = completion({ modelId: llmId, history, stream: true, temperature: 0.2, tools, toolDialect: dialect, captureThinking: true, emitRawDeltas: true });
  let raw = "";
  for await (const e of run.events) if (e.type === "rawDelta") raw += e.text;
  const final = await run.final.catch((err) => ({ _err: String(err?.message || err) }));
  const n = final?.toolCalls?.length || 0;
  console.log(`\n===== explicit-JSON + dialect=${dialect} =====`);
  console.log(`parsed toolCalls: ${n}${n ? " → " + JSON.stringify(final.toolCalls.map((c) => ({ name: c.name, args: c.arguments }))) : ""}`);
  console.log("content (no think):", JSON.stringify((final?.contentText || "").slice(0, 260)));
}
process.exit(0);
