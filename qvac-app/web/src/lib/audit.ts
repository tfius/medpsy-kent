// Client-side audit logger. Every meaningful event (stage change, patient, consent,
// each conversation turn, STT/TTS, translation, ICD, outcome, sign-off) is POSTed to the
// server's append-only, hash-chained per-encounter log (/api/audit). Raw model I/O is
// logged server-side by the /v1 shim, correlated by the same encounterId.
//
// Fire-and-forget + keepalive so logging never blocks or breaks the UI; if the API is
// down the event is simply dropped (the kiosk keeps working).

const EID_KEY = "medpsy.encounterId";
let encounterId = "";
try { encounterId = localStorage.getItem(EID_KEY) || ""; } catch { /* ignore */ }

export function getAuditEncounter(): string { return encounterId; }
export function setAuditEncounter(id: string): void {
  encounterId = id || "";
  try { localStorage.setItem(EID_KEY, encounterId); } catch { /* ignore */ }
}

// Start a fresh encounter (new patient / kiosk turnover). Returns the new id.
export function newEncounter(meta: Record<string, unknown> = {}): string {
  const rand = Math.random().toString(16).slice(2, 8);
  const id = `enc-${Date.now()}-${rand}`;
  setAuditEncounter(id);
  logEvent("encounter.start", { ...meta, ua: typeof navigator !== "undefined" ? navigator.userAgent : "" }, "system");
  return id;
}

export function logEvent(type: string, data: Record<string, unknown> = {}, actor = "system"): void {
  if (!encounterId) return;
  try {
    fetch("/api/audit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ encounterId, type, actor, data }),
      keepalive: true, // survive navigation/unload
    }).catch(() => { /* API down -> drop */ });
  } catch { /* ignore */ }
}

// Semantic helpers (used across the app).
export const audit = {
  stage: (path: string, name?: string) => logEvent("stage.enter", { path, name }, "patient"),
  patient: (p: { id?: string; name?: string }) => logEvent("patient", p, "clinician"),
  consent: (c: Record<string, unknown>) => logEvent("consent", c, "patient"),
  userTurn: (text: string) => logEvent("message.user", { text }, "patient"),
  botTurn: (text: string, reason?: string) => logEvent("message.assistant", { text, reason }, "model"),
  stt: (d: { text: string; lang?: string }) => logEvent("stt", d, "patient"),
  tts: (d: { text: string; voice?: string; lang?: string }) => logEvent("tts", d, "system"),
  translation: (d: { dir: string; from: string; to: string; src: string; out: string }) => logEvent("translation", d, "system"),
  icd: (d: Record<string, unknown>) => logEvent("icd", d, "system"),
  outcome: (o: Record<string, unknown>) => logEvent("outcome", o, "model"),
  signoff: (d: Record<string, unknown>) => logEvent("signoff", d, "clinician"),
  note: (text: string) => logEvent("note", { text }, "system"),
};

// --- viewer API (read side) ---
export interface AuditEvent {
  v: number; encounterId: string; seq: number; ts: string;
  type: string; actor: string; data: Record<string, unknown>; prevHash: string; hash: string;
}
export interface EncounterSummary {
  encounterId: string; start: string; last: string; events: number;
  patient: { name?: string; id?: string } | null; lang: string | null;
  decision: string | null; band: string | null; integrity: boolean;
}
export interface Integrity { ok: boolean; count: number; brokenAt?: number; reason?: string }

const j = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  return r.ok ? r.json() : null;
};
export const listEncounters = (): Promise<EncounterSummary[]> =>
  j("/api/audit").then((d) => d?.encounters || []);
export const getEncounter = (id: string): Promise<{ events: AuditEvent[]; integrity: Integrity } | null> =>
  j(`/api/audit/${encodeURIComponent(id)}`);
export const exportEncounter = (id: string) => j(`/api/audit/${encodeURIComponent(id)}/export`);
export const importBundle = (bundle: unknown) =>
  j("/api/audit/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bundle) });
