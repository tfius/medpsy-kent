// LM Studio (OpenAI-compatible) provider — works TODAY against your running server
// (medpsy-4b + nomic embeddings). No QVAC native build, no model copy needed for dev.
import { LMSTUDIO_URL, LMSTUDIO_LLM, LMSTUDIO_EMBED, TEMPERATURE, MAX_TOKENS } from "../config.js";
import { stripThink } from "../think.js";

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

    // Streaming variant for the /v1 shim. Forwards LM Studio's SSE deltas, preserving
    // the content vs reasoning_content split: onToken(token, "content"|"reasoning").
    async completeStream(history, { temperature = TEMPERATURE, maxTokens = MAX_TOKENS } = {}, onToken) {
      const r = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: LMSTUDIO_LLM, messages: history,
          temperature, max_tokens: maxTokens, stream: true,
        }),
      });
      if (!r.ok || !r.body) throw new Error(`LM Studio ${r.status}: ${await r.text().catch(() => "")}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "", text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const l = line.trim();
          if (!l.startsWith("data:")) continue;
          const p = l.slice(5).trim();
          if (p === "[DONE]") continue;
          try {
            const d = JSON.parse(p).choices?.[0]?.delta || {};
            if (d.reasoning_content) onToken?.(d.reasoning_content, "reasoning");
            if (d.content) { text += d.content; onToken?.(d.content, "content"); }
          } catch { /* keep-alive / partial frame */ }
        }
      }
      return text.trim();
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

    // One agent turn with tools (OpenAI tools API). Returns the assistant message:
    // { content, toolCalls, reasoning, finish }. medpsy-4b emits native tool_calls.
    async chatWithTools(history, tools, { temperature = TEMPERATURE, maxTokens = MAX_TOKENS, signal } = {}) {
      const r = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: LMSTUDIO_LLM, messages: history, tools, tool_choice: "auto",
          temperature, max_tokens: maxTokens, stream: false,
        }),
        signal,
      });
      if (!r.ok) throw new Error(`LM Studio ${r.status}: ${await r.text()}`);
      const d = await r.json();
      const m = d.choices?.[0]?.message || {};
      return {
        content: stripThink(m.content || ""),
        toolCalls: m.tool_calls || [],
        reasoning: (m.reasoning_content || "").trim(),
        finish: d.choices?.[0]?.finish_reason,
      };
    },

    // Streaming agent turn: emits content tokens via onDelta as they arrive (the final
    // answer streams; a tool-call turn produces no content), assembling tool_calls from the
    // streamed deltas. Returns the same { content, toolCalls, reasoning } shape.
    async chatWithToolsStream(history, tools, { temperature = TEMPERATURE, maxTokens = MAX_TOKENS, signal } = {}, onDelta) {
      const r = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: LMSTUDIO_LLM, messages: history, tools, tool_choice: "auto",
          temperature, max_tokens: maxTokens, stream: true,
        }),
        signal,
      });
      if (!r.ok || !r.body) throw new Error(`LM Studio ${r.status}: ${await r.text().catch(() => "")}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "", content = "", reasoning = "";
      const calls = []; // assembled by index
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const l = line.trim();
          if (!l.startsWith("data:")) continue;
          const p = l.slice(5).trim();
          if (p === "[DONE]") continue;
          let delta;
          try { delta = JSON.parse(p).choices?.[0]?.delta || {}; } catch { continue; }
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
          if (delta.content) { content += delta.content; onDelta?.(delta.content); }
          for (const tc of delta.tool_calls || []) {
            const i = tc.index ?? 0;
            calls[i] ??= { id: tc.id, type: "function", function: { name: "", arguments: "" } };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function?.name) calls[i].function.name += tc.function.name;
            if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
          }
        }
      }
      return { content: stripThink(content), toolCalls: calls.filter(Boolean), reasoning: reasoning.trim() };
    },

    async close() {},
  };
}
