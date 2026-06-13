// Read an SSE response body, invoking onFrame with each parsed JSON `data:` frame.
// One copy of the framing/buffer logic, shared by the agent stream and the chat stream,
// so a fix (partial frames, keep-alives) can't drift between them.
export async function readSSE(res: Response, onFrame: (frame: unknown) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || ""; // keep the trailing partial line for the next chunk
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue; // ignore comments/keep-alives
      const p = l.slice(5).trim();
      if (p === "[DONE]") continue;
      try { onFrame(JSON.parse(p)); } catch { /* partial/non-JSON frame */ }
    }
  }
}
