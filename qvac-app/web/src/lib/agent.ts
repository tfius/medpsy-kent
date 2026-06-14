// Client for the medpsy agent loop (POST /api/agent, SSE). The server runs the
// tool-calling loop on-device and streams typed events; we forward them to onEvent.
import { getAuditEncounter } from "./audit";
import { readSSE } from "./sse";

export type AgentMsg = { role: "user" | "assistant"; content: string };
export type AgentEvent =
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: unknown }
  | { type: "answer_delta"; text: string }   // streamed final-answer token(s)
  | { type: "answer"; text: string }          // full final answer (also closes a streamed one)
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

// --- agent-proposed facts awaiting clinician confirmation (the trust loop) ---
export interface Proposal { statementId: string; subject: string; predicate: string; object: unknown; source: string; confidence: number }
const patientLog = () => `patient:${getAuditEncounter()}`;

export async function listProposals(): Promise<Proposal[]> {
  if (!getAuditEncounter()) return [];
  try {
    const r = await fetch(`/api/facts/${encodeURIComponent(patientLog())}?status=proposed`);
    return r.ok ? (await r.json()).facts || [] : [];
  } catch { return []; }
}
export async function resolveProposal(statementId: string, op: "confirm" | "reject"): Promise<boolean> {
  if (!getAuditEncounter()) return false;
  try {
    const r = await fetch(`/api/facts/${encodeURIComponent(patientLog())}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, statementId }),
    });
    return r.ok;
  } catch { return false; }
}

// Render a fact's object compactly.
export const factText = (p: Proposal) => `${p.predicate} ${typeof p.object === "object" ? JSON.stringify(p.object) : String(p.object)}`;
