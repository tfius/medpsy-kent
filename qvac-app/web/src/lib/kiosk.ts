// A client for ONE kiosk addressed by absolute base URL (e.g. http://localhost:8788) — so the
// two-kiosk demo can drive Kiosk A and observe Kiosk B in the same page (cross-origin; the
// server sends CORS headers). Mirrors the relevant /api/learn + /api/kb endpoints.
import type { VetResult, PairCheck, Learning } from "./learn";
import type { BackendInfo } from "./trust";

export interface MeshMembership { enforced: boolean; count: number | null; self?: string }
export interface SignalRow { pairKey: string; a: string; b: string; seen: number; flagged: number; contributors: number; rate: number }
export interface SignalProposal extends SignalRow { id: string; severity: string }
export interface SignalStatus { threshold: { minContributors: number; minFlagged: number; minRate: number }; contributors: number; aggregate: SignalRow[]; crossing: SignalRow[]; me: string }
export interface KioskBackend extends BackendInfo { devicePublicKey?: string; consultPeers?: number; membership?: { enforced: boolean; count: number | null } }

export function kiosk(base: string) {
  const j = async <T,>(p: string, init?: RequestInit): Promise<T | null> => {
    try { const r = await fetch(base + p, init); return r.ok ? await r.json() : await r.json().catch(() => null); } catch { return null; }
  };
  const post = <T,>(p: string, body?: unknown) =>
    j<T>(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return {
    base,
    backend: () => j<KioskBackend>("/api/backend"),
    check: (a: string, b: string) => j<PairCheck>(`/api/learn/check?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
    learn: () => j<Learning>("/api/learn"),
    distill: (correction: string) => post<{ distilled: number; proposed: { id: string; a: string; b: string }[] }>("/api/learn/distill", { correction }),
    vet: (edgeId: string) => post<VetResult>("/api/learn/vet", { edgeId }),
    promote: (edgeId: string) => post<{ promoted: boolean }>("/api/learn/promote", { edgeId }),
    members: (keys?: string[]) => keys === undefined
      ? j<MeshMembership>("/api/consult/members")
      : post<MeshMembership>("/api/consult/members", { keys }),
    // Federated safety intelligence (pharmacovigilance).
    signals: () => j<SignalStatus>("/api/signals"),
    observeSignal: (a: string, b: string, adverse: boolean) => post<{ recorded: unknown[] }>("/api/signals/observe", { a, b, adverse }),
    scanSignals: () => post<{ crossing: SignalRow[]; proposed: SignalProposal[] }>("/api/signals/scan"),
    kb: () => j<{ count: number; peers: { key: string }[] }>("/api/kb"),
    share: () => post<{ key: string }>("/api/kb/share"),
    join: (key: string) => post<{ joined?: string | false; total?: number; reason?: string }>("/api/kb/join", { key }),
    sync: () => post<{ peers: number; merged: number; count: number }>("/api/kb/sync"),
  };
}
export type Kiosk = ReturnType<typeof kiosk>;
