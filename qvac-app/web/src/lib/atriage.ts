// Client for the agentic triage loop (POST /api/agentic-triage, SSE). The conversation is
// held per-encounter on the server, so we just send the next patient utterance.
import { getAuditEncounter } from "./audit";
import { readSSE } from "./sse";

export type Supervision = { agreed: boolean; escalated: boolean; from: string; missedRedFlags: string; rationale: string; error?: unknown };
export type Critique = { agree: boolean; decision?: string; severity?: number; missedRedFlags?: string; rationale?: string };
export type TriageOutcome = {
  decision: string; severity: number; band: "RED" | "AMBER" | "GREEN" | "";
  condition: string; icd: string; icdGuess?: string; icdDescription?: string;
  redFlags: string; routing: string; safetyNet: string; supervised?: Supervision;
};
export type ATriageEvent =
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: unknown }
  | { type: "question"; text: string }
  | { type: "critique"; verdict: Critique }
  | { type: "conclusion"; outcome: TriageOutcome }
  | { type: "done" }
  | { type: "error"; error: string };

export async function runTriageTurn(
  message: string,
  onEvent: (e: ATriageEvent) => void,
  opts: { reset?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";
  let res: Response;
  try {
    res = await fetch("/api/agentic-triage", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ encounterId: getAuditEncounter(), message, reset: opts.reset }),
      signal: opts.signal,
    });
  } catch (e) { if (!isAbort(e)) onEvent({ type: "error", error: e instanceof Error ? e.message : String(e) }); return; }
  if (!res.ok || !res.body) { onEvent({ type: "error", error: `triage unavailable (${res.status})` }); return; }
  try { await readSSE(res, (f) => onEvent(f as ATriageEvent)); }
  catch (e) { if (!isAbort(e)) onEvent({ type: "error", error: e instanceof Error ? e.message : String(e) }); }
}

export const toolLabel = (n: string) => n.replace(/_/g, " ");

// Build the shared Triage shape (for <TriageResult>) from the agent's structured outcome.
export const outcomeToTriage = (o: TriageOutcome) => ({
  decision: o.decision, severity: String(o.severity ?? ""), band: o.band,
  redFlags: o.redFlags, condition: o.icdDescription ? `${o.condition} (${o.icdDescription})` : o.condition,
  icd: o.icd, routing: o.routing, safetyNet: o.safetyNet,
});
