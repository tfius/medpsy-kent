// Client for the medpsy agent loop (POST /api/agent, SSE). The server runs the
// tool-calling loop on-device and streams typed events; we forward them to onEvent.
import { getAuditEncounter } from "./audit";
import { readSSE } from "./sse";

export type AgentMsg = { role: "user" | "assistant"; content: string };
export type AgentEvent =
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: unknown }
  | { type: "answer"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

export async function runAgent(
  messages: AgentMsg[],
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";
  let res: Response;
  try {
    res = await fetch("/api/agent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, encounterId: getAuditEncounter() }), signal,
    });
  } catch (e) { if (!isAbort(e)) onEvent({ type: "error", error: e instanceof Error ? e.message : String(e) }); return; }
  if (!res.ok || !res.body) {
    onEvent({ type: "error", error: `agent unavailable (${res.status})` }); return;
  }
  try {
    await readSSE(res, (frame) => onEvent(frame as AgentEvent));
  } catch (e) { if (!isAbort(e)) onEvent({ type: "error", error: e instanceof Error ? e.message : String(e) }); }
}

// "lookup_icd10" -> "lookup icd10"
export const toolLabel = (name: string) => name.replace(/_/g, " ");
