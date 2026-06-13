// Strip a reasoning model's <think>…</think> chain-of-thought from answer text.
// Handles both closed blocks AND a trailing UNTERMINATED <think> (the model ran out of
// budget mid-reasoning) — leaving the latter in would leak raw reasoning into the
// pharmacist-facing answer and the audit log.
export function stripThink(text) {
  let out = (text || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
  const open = out.search(/<think>/i);
  if (open !== -1) out = out.slice(0, open); // drop a dangling, never-closed block
  return out.trim();
}
