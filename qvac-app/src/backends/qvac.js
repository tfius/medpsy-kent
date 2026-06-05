// QVAC SDK provider — local-first, on-device inference (the hackathon target).
// Loads medpsy-4b from the local .gguf (no re-download) and an embedding model, then
// runs completion()/embed() on this machine via QVAC's llama.cpp engine.
import { QVAC_LLM_GGUF, QVAC_EMBED_GGUF, TEMPERATURE } from "../config.js";

export async function makeQvacProvider() {
  const sdk = await import("@qvac/sdk"); // dynamic so LM-Studio mode needs no native build
  const { loadModel, completion, embed, unloadModel, GTE_LARGE_FP16 } = sdk;
  let llmId, embId;

  return {
    name: "qvac(medpsy-4b.gguf)",

    async init(onProgress) {
      llmId = await loadModel({ modelSrc: QVAC_LLM_GGUF, modelType: "llm", onProgress });
      embId = await loadModel({
        modelSrc: QVAC_EMBED_GGUF || GTE_LARGE_FP16,
        modelType: "embeddings", onProgress,
      });
    },

    async complete(history, { temperature = TEMPERATURE } = {}) {
      const res = completion({ modelId: llmId, history, stream: true, temperature });
      let text = "";
      for await (const token of res.tokenStream) text += token;
      return text.trim();
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
