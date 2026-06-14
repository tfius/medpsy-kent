// QVAC SDK provider — local-first, on-device inference (the hackathon target).
// Loads medpsy-4b from the local .gguf (no re-download) and an embedding model, then
// runs completion()/embed() on this machine via QVAC's llama.cpp engine.
import { QVAC_LLM_GGUF, QVAC_EMBED_GGUF, TEMPERATURE } from "../config.js";
import { stripThink } from "../think.js";

// --- agent ↔ QVAC SDK translation -------------------------------------------------------
// agent.js speaks OpenAI's tool grammar (nested `{function:{…}}` defs; assistant.tool_calls +
// role:"tool" result messages). The QVAC SDK speaks its own: a FLAT tool schema
// ({type,name,description,parameters}) and a strict {role,content:string} history with no
// structured tool turns. These adapters bridge the two so src/agent.js stays backend-agnostic.

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array"]);

// OpenAI/JSON-Schema parameters -> QVAC's flat tool `parameters` (each property must carry a
// type from the allowed enum; nested sub-schemas/keywords the SDK doesn't model are dropped).
function sanitizeParams(params) {
  const src = (params && params.properties) || {};
  const properties = {};
  for (const [k, v] of Object.entries(src)) {
    const t = JSON_TYPES.has(v?.type) ? v.type : "string";
    properties[k] = { type: t };
    if (v?.description) properties[k].description = String(v.description);
    if (Array.isArray(v?.enum)) properties[k].enum = v.enum.map(String);
  }
  const required = Array.isArray(params?.required) ? params.required.filter((r) => r in properties) : [];
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

// OpenAI tool defs (`{type:"function", function:{name,description,parameters}}`) -> the SDK's
// native flat `toolSchema`. Passing the nested form crashes the SDK (it tries to read a Zod
// `.shape` off the missing `parameters`).
function toQvacTools(tools) {
  return (tools || []).map((t) => {
    const fn = t.function || t; // accept nested or already-flat
    return { type: "function", name: fn.name, description: fn.description || fn.name, parameters: sanitizeParams(fn.parameters) };
  });
}

// OpenAI history -> QVAC {role,content}. The SDK history has no tool_calls / role:"tool", so a
// prior tool-call turn is rendered into the assistant's text and a tool RESULT becomes a user
// message — what gemma4 needs to continue. Consecutive same-role messages are coalesced
// (gemma templates expect user/assistant alternation).
function toQvacHistory(history) {
  const flat = [];
  for (const m of history || []) {
    if (m.role === "tool") {
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      flat.push({ role: "user", content: `Tool result — ${m.name || "tool"}: ${body}` });
    } else if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((tc) => `«called ${tc.function?.name}(${tc.function?.arguments || "{}"})»`).join(" ");
      flat.push({ role: "assistant", content: [m.content, calls].filter(Boolean).join("\n") });
    } else {
      flat.push({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") });
    }
  }
  const merged = [];
  for (const m of flat) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

// SDK tool calls (`{id,name,arguments}` — final.toolCalls items ARE the call object, not
// `{call:…}`) -> the OpenAI shape agent.js feeds back.
const toOpenAiCalls = (calls) => (calls || []).map((tc) => {
  const c = tc.call || tc; // tolerate either shape
  return { id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } };
});

// medpsy on QVAC does NOT emit the SDK's native tool-call tokens (the SDK's toolDialect is a
// PARSER selection; it doesn't prime the model's chat template the way LM Studio's server
// does). But when told the format explicitly, medpsy reliably emits a clean JSON tool call —
// the SDK's parser still misses it (it's wrapped in <think> + newlines), so we (a) inject the
// format instruction and (b) recover the JSON ourselves. Confines the quirk to this provider.
function toolPreamble(tools) {
  const lines = (tools || []).map((t) => {
    const fn = t.function || t;
    const ps = Object.entries(fn.parameters?.properties || {}).map(([k, v]) => `${k}: ${v.type || "string"}`).join(", ");
    return `- ${fn.name}(${ps})${fn.description ? " — " + fn.description : ""}`;
  });
  return `You can call tools to ground your answer. Available tools:\n${lines.join("\n")}\n\n` +
    `To call a tool, reply with ONLY a single JSON object and nothing else:\n` +
    `{"name": "<tool name>", "arguments": { ... }}\n` +
    `After you receive the result (a "Tool result — …" message), either call another tool the same way or give your final answer in plain prose. Prefer tools over memory for codes, interactions, and patient facts.`;
}

// Parse a tool call medpsy wrote as TEXT (the SDK didn't). Guarded: the parsed name must be a
// real tool, so a normal answer that merely contains JSON isn't mistaken for a call.
function recoverTextToolCall(content, tools) {
  const names = new Set((tools || []).map((t) => (t.function || t).name));
  const m = (content || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o; try { o = JSON.parse(m[0]); } catch { return null; }
  const cand = o.tool_call || (Array.isArray(o.tool_calls) ? o.tool_calls[0] : null) || o;
  const name = cand?.name || cand?.function?.name;
  if (!name || !names.has(name)) return null;
  const args = cand?.arguments ?? cand?.function?.arguments ?? {};
  return [{ id: `call_${name}_${Math.abs(content.length * 2654435761 % 1e8).toString(16)}`, type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }];
}

export async function makeQvacProvider() {
  const sdk = await import("@qvac/sdk"); // dynamic so LM-Studio mode needs no native build
  const { loadModel, completion, embed, unloadModel } = sdk;
  let llmId, embId;

  // One agent turn with tools via the SDK's NATIVE tool calling (gemma4 dialect for medpsy).
  // Streams content through onDelta when provided. Normalized to the same
  // { content, toolCalls, reasoning } shape the LM Studio path returns.
  async function toolTurn(history, tools, { temperature = TEMPERATURE, signal } = {}, onDelta) {
    // Inject the tool-emission instruction into the system message so medpsy emits a
    // parseable call (the SDK doesn't prime it). Stream content unless it turns out to be a
    // text-emitted tool call — we don't want a half-JSON blob streamed to the client.
    const qHistory = toQvacHistory(history);
    if ((tools || []).length) {
      const pre = toolPreamble(tools);
      const sys = qHistory.find((m) => m.role === "system");
      if (sys) sys.content = `${sys.content}\n\n${pre}`;
      else qHistory.unshift({ role: "system", content: pre });
    }
    const run = completion({
      modelId: llmId, history: qHistory, stream: true, temperature,
      tools: toQvacTools(tools), toolDialect: "json", captureThinking: true,
    });
    let content = "", reasoning = "";
    const calls = [];
    // Decide once, on the first non-whitespace content char, whether to stream: a tool-call
    // turn outputs ONLY a JSON object (per the preamble), and we recover+suppress it — so we
    // must NOT stream that JSON to the client. Prose answers (anything not starting with `{`)
    // stream normally.
    let streamDecided = false, streamOn = false;
    for await (const event of run.events) {
      if (signal?.aborted) { try { run.cancel?.(); } catch { /* best effort */ } break; }
      if (event.type === "contentDelta") {
        content += event.text;
        if (onDelta) {
          if (!streamDecided) {
            const head = content.replace(/^\s+/, "");
            if (!head) continue;                  // still leading whitespace — wait
            streamDecided = true; streamOn = !/^(\{|```)/.test(head); // `{` or a ```json fence ⇒ a tool call
            if (streamOn) onDelta(head);           // flush the buffered first prose token(s)
            continue;
          }
          if (streamOn) onDelta(event.text);
        }
      }
      else if (event.type === "thinkingDelta") reasoning += event.text;
      else if (event.type === "toolCall") calls.push(event.call);
    }
    const final = await run.final.catch(() => null);
    let text = stripThink((final?.contentText ?? content) || "");
    let toolCalls = toOpenAiCalls(final?.toolCalls?.length ? final.toolCalls : calls);
    if (!toolCalls.length) {
      const recovered = recoverTextToolCall(text, tools); // medpsy wrote the call as text
      if (recovered) { toolCalls = recovered; text = ""; }
    }
    return { content: text, toolCalls, reasoning: ((final?.thinkingText ?? reasoning) || "").trim() };
  }

  return {
    name: "qvac(medpsy-4b.gguf)",

    async init(onProgress) {
      // The SDK defaults to ctx_size 1024 — far too small once the system prompt, tool
      // definitions, and a tool result (e.g. ICD candidates) are in the prompt. Load medpsy
      // with a real window so multi-turn tool loops + the triage interview fit.
      const ctx_size = Number(process.env.MEDPSY_QVAC_CTX) || 8192;
      llmId = await loadModel({ modelSrc: QVAC_LLM_GGUF, modelType: "llm", modelConfig: { ctx_size }, onProgress });
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

    chatWithTools(history, tools, opts = {}) { return toolTurn(history, tools, opts); },
    chatWithToolsStream(history, tools, opts = {}, onDelta) { return toolTurn(history, tools, opts, onDelta); },

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
