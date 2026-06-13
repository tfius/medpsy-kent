// QVAC SDK provider — local-first, on-device inference (the hackathon target).
// Loads medpsy-4b from the local .gguf (no re-download) and an embedding model, then
// runs completion()/embed() on this machine via QVAC's llama.cpp engine.
import { QVAC_LLM_GGUF, QVAC_EMBED_GGUF, TEMPERATURE } from "../config.js";
import { stripThink } from "../think.js";

export async function makeQvacProvider() {
  const sdk = await import("@qvac/sdk"); // dynamic so LM-Studio mode needs no native build
  const { loadModel, completion, embed, unloadModel } = sdk;
  let llmId, embId;

  return {
    name: "qvac(medpsy-4b.gguf)",

    async init(onProgress) {
      llmId = await loadModel({ modelSrc: QVAC_LLM_GGUF, modelType: "llm", onProgress });
      // Local nomic gguf (no registry/P2P) — matches the 768-d ICD index.
      embId = await loadModel({ modelSrc: QVAC_EMBED_GGUF, modelType: "embeddings", onProgress });
    },

    async complete(history, { temperature = TEMPERATURE } = {}) {
      const res = completion({ modelId: llmId, history, stream: true, temperature });
      let text = "";
      for await (const token of res.tokenStream) text += token;
      return text.trim();
    },

    // Streaming variant for the /v1 shim. onToken(token, kind) — medpsy emits its
    // reasoning inline as <think>…</think> in the content stream, so kind is always
    // "content" here; the client separates reasoning from the answer.
    async completeStream(history, { temperature = TEMPERATURE } = {}, onToken) {
      const res = completion({ modelId: llmId, history, stream: true, temperature });
      let text = "";
      for await (const token of res.tokenStream) { text += token; onToken?.(token, "content"); }
      return text.trim();
    },

    // One agent turn with tools, via the SDK's NATIVE tool calling (gemma4 dialect for
    // medpsy). Normalized to the same { content, toolCalls, reasoning } shape the LM
    // Studio path returns, so src/agent.js is backend-agnostic. NB: the OpenAI-style
    // tool-result history that agent.js feeds back (assistant.tool_calls + role:"tool")
    // should be verified against the live SDK when running MEDPSY_BACKEND=qvac.
    async chatWithTools(history, tools, { temperature = TEMPERATURE } = {}) {
      const run = completion({ modelId: llmId, history, stream: true, temperature, tools, toolDialect: "gemma4" });
      // Drain the event stream so `final` resolves even if the SDK applies backpressure
      // on an unread stream (mirrors how complete() pumps tokenStream).
      for await (const _ of run.events) { /* pump */ }
      const final = await run.final;
      return {
        content: stripThink(final.contentText || ""),
        toolCalls: (final.toolCalls || []).map((tc) => ({
          id: tc.call.id, type: "function",
          function: { name: tc.call.name, arguments: JSON.stringify(tc.call.arguments || {}) },
        })),
        reasoning: (final.thinkingText || "").trim(),
      };
    },

    async embed(texts) {
      const { embedding } = await embed({ modelId: embId, text: texts });
      return Array.isArray(embedding[0]) ? embedding : [embedding]; // -> number[][]
    },

    async close() {
      if (llmId) await unloadModel({ modelId: llmId });
      if (embId) await unloadModel({ modelId: embId });
    },
  };
}
