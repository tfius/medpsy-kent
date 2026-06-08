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

// Streaming variant: calls onDelta with the accumulated text as tokens arrive; returns
// the final (think-stripped) content. Used by the triage duel for a live feel.
export async function chatStream(
  messages: Msg[],
  onDelta: (accumulated: string) => void,
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
  let buf = "", full = "";
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
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) { full += delta; onDelta(full); }
      } catch { /* ignore keep-alives / partial frames */ }
    }
  }
  return full.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
