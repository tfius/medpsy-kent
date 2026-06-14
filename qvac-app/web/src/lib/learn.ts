// Client for the edge-learning loop (/api/learn): propose a candidate interaction edge, have
// medpsy adversarially vet it, promote survivors into the grounded/federated graph or reject.

export interface Candidate {
  id: string; a: string; b: string; severity?: string; note?: string;
  contributedBy?: string; votes: { by: string; real?: boolean; severity?: string; reason?: string }[];
}
export interface PromotedEdge { a: string; b: string; severity?: string; note?: string; by?: string }
export interface Learning { pending: Candidate[]; promoted: PromotedEdge[] }
export interface Verdict { real: boolean; severity?: string; reason?: string }
export interface PeerVerdict extends Verdict { by?: string; signatureOk?: boolean; error?: string }
export interface VetResult { local: Verdict; peer?: PeerVerdict | null }

const post = async <T,>(url: string, b?: unknown): Promise<T | null> => {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
    return r.ok ? await r.json() : await r.json().catch(() => null);
  } catch { return null; }
};

export const getLearning = async (): Promise<Learning | null> => {
  try { const r = await fetch("/api/learn"); return r.ok ? await r.json() : null; } catch { return null; }
};
export const proposeEdge = (e: { a: string; b: string; severity: string; note: string }) =>
  post<{ id: string }>("/api/learn/propose", e);
export const vetEdge = (edgeId: string) => post<VetResult>("/api/learn/vet", { edgeId });
export const promoteEdge = (edgeId: string, severity?: string) => post<{ promoted: boolean }>("/api/learn/promote", { edgeId, severity });
export const rejectEdge = (edgeId: string) => post<{ rejected: boolean }>("/api/learn/reject", { edgeId });

export const drug = (id: string) => String(id).replace(/^drug:/, "");
