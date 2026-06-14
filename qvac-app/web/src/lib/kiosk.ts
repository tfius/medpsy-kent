// A client for ONE kiosk addressed by absolute base URL (e.g. http://localhost:8788) — so the
// two-kiosk demo can drive Kiosk A and observe Kiosk B in the same page (cross-origin; the
// server sends CORS headers). Mirrors the relevant /api/learn + /api/kb endpoints.
import type { VetResult, PairCheck, Learning } from "./learn";
import type { BackendInfo } from "./trust";

export function kiosk(base: string) {
  const j = async <T,>(p: string, init?: RequestInit): Promise<T | null> => {
    try { const r = await fetch(base + p, init); return r.ok ? await r.json() : await r.json().catch(() => null); } catch { return null; }
  };
  const post = <T,>(p: string, body?: unknown) =>
    j<T>(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  return {
    base,
    backend: () => j<BackendInfo>("/api/backend"),
    check: (a: string, b: string) => j<PairCheck>(`/api/learn/check?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
    learn: () => j<Learning>("/api/learn"),
    distill: (correction: string) => post<{ distilled: number; proposed: { id: string; a: string; b: string }[] }>("/api/learn/distill", { correction }),
    vet: (edgeId: string) => post<VetResult>("/api/learn/vet", { edgeId }),
    promote: (edgeId: string) => post<{ promoted: boolean }>("/api/learn/promote", { edgeId }),
    kb: () => j<{ count: number; peers: { key: string }[] }>("/api/kb"),
    share: () => post<{ key: string }>("/api/kb/share"),
    join: (key: string) => post<{ joined?: string | false; total?: number; reason?: string }>("/api/kb/join", { key }),
    sync: () => post<{ peers: number; merged: number; count: number }>("/api/kb/sync"),
  };
}
export type Kiosk = ReturnType<typeof kiosk>;
