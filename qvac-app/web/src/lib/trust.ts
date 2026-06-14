// Client for the Trust dashboard: where inference runs (on-device vs dev) and the agent's
// measured tool-use / grounding / escalation scores.

export interface BackendInfo {
  backend: string; mode: string; onDevice: boolean; cloud: boolean; peerConsult?: boolean; model: string; note: string;
}
export interface EvalRow {
  id: string; q: string; pass: boolean; tools: string[]; expectTools: string[];
  toolOk: boolean; answerOk: boolean; escalateOk: boolean;
}
export interface EvalResults {
  backend: string; runs: number; at: string; cases: number;
  summary: {
    overall: { pass: number; n: number; pct: number };
    tool: { pass: number; n: number; pct: number };
    grounding: { pass: number; n: number; pct: number };
    escalation: { pass: number; n: number };
  };
  rows: EvalRow[];
}

const j = async <T,>(url: string): Promise<T | null> => {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
};

export const getBackendInfo = () => j<BackendInfo>("/api/backend");
export const getEvalResults = () => j<EvalResults>("/api/eval");
