// LM Studio (OpenAI-compatible) provider — works TODAY against your running server
// (medpsy-4b + nomic embeddings). No QVAC native build, no model copy needed for dev.
import { LMSTUDIO_URL, LMSTUDIO_LLM, LMSTUDIO_EMBED, TEMPERATURE, MAX_TOKENS } from "../config.js";

export function makeLmStudioProvider() {
  return {
    name: `lmstudio(${LMSTUDIO_LLM})`,
    async init() {},

    async complete(history, { temperature = TEMPERATURE, maxTokens = MAX_TOKENS } = {}) {
      const r = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: LMSTUDIO_LLM, messages: history,
          temperature, max_tokens: maxTokens, stream: false,
        }),
      });
      if (!r.ok) throw new Error(`LM Studio ${r.status}: ${await r.text()}`);
      const d = await r.json();
      return (d.choices?.[0]?.message?.content || "").trim();
    },

    async embed(texts) {
      const r = await fetch(`${LMSTUDIO_URL}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: LMSTUDIO_EMBED, input: texts }),
      });
      if (!r.ok) throw new Error(`LM Studio embeddings ${r.status}: ${await r.text()}`);
      const d = await r.json();
      return d.data.map((x) => x.embedding); // number[][]
    },

    async close() {},
  };
}
