// Client for the shared/federated knowledge graph (the interaction graph), replicated
// kiosk-to-kiosk over hyperswarm with no server (src/kb-sync.js + /api/kb).

export interface KbEdge { a: string; b: string; severity?: string; note?: string; source: string }
export interface KbStatus {
  count: number; sharing: boolean; key: string | null;
  peers: { key: string; importedAt: string }[]; edges: KbEdge[];
}

const j = async <T,>(url: string, init?: RequestInit): Promise<T | null> => {
  try { const r = await fetch(url, init); return r.ok ? await r.json() : await r.json().catch(() => null); } catch { return null; }
};

export const getKbStatus = () => j<KbStatus>("/api/kb");
export const shareKb = () => j<{ key: string }>("/api/kb/share", { method: "POST" });
export const joinKb = (key: string) =>
  j<{ joined?: string | false; imported?: number; total?: number; error?: string; reason?: string }>(
    "/api/kb/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
