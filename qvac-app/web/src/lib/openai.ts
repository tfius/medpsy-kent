// Minimal OpenAI-compatible chat client. Hits /v1 (Vite proxies to LM Studio today,
// or a QVAC CLI server later). Same contract either way.
export type Msg = { role: "system" | "user" | "assistant"; content: string };

const MODEL = import.meta.env.VITE_LLM_MODEL || "medpsy-4b";

export async function chat(
  messages: Msg[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const res = await fetch("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 8192, // >=8k: reasoning models need room before answering
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let content: string = data.choices?.[0]?.message?.content || "";
  // reasoning models sometimes inline <think>…</think>; keep only the final answer
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return content;
}

// Separate a (possibly streaming/unclosed) content string into reasoning vs answer.
// Handles <think>…</think> blocks (closed and trailing-open).
export function splitThink(content: string): { reasoning: string; answer: string } {
  let reasoning = "";
  let answer = content.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => { reasoning += inner; return ""; });
  const open = answer.indexOf("<think>");
  if (open !== -1) { reasoning += answer.slice(open + 7); answer = answer.slice(0, open); }
  return { reasoning: reasoning.trim(), answer: answer.trim() };
}

export type StreamProgress = { reasoning: string; answer: string };

// Streaming variant: onProgress fires with the accumulated {reasoning, answer} as tokens
// arrive (reasoning from delta.reasoning_content and/or <think> blocks). Returns the final
// answer (reasoning stripped). Used by the triage duel for a live feel.
export async function chatStream(
  messages: Msg[],
  onProgress: (p: StreamProgress) => void,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const res = await fetch("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 8192,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`LLM ${res.status}: ${await res.text().catch(() => "")}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", reasoningField = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const payload = l.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta || {};
        if (delta.reasoning_content) reasoningField += delta.reasoning_content;
        if (delta.content) content += delta.content;
        if (delta.reasoning_content || delta.content) {
          const { reasoning, answer } = splitThink(content);
          onProgress({ reasoning: (reasoningField + "\n" + reasoning).trim(), answer });
        }
      } catch { /* ignore keep-alives / partial frames */ }
    }
  }
  return splitThink(content).answer;
}
