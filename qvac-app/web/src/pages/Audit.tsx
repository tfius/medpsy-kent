// Audit viewer — per-patient log: list → timeline, integrity verification, export
// (signed bundle) for sharing, and import (verify + view) of a shared bundle.
// Clinician/audit view; kept in canonical English.
import { useEffect, useRef, useState } from "react";
import {
  listEncounters, getEncounter, exportEncounter, importBundle,
  type AuditEvent, type EncounterSummary, type Integrity,
} from "../lib/audit";

const TYPE_ICON: Record<string, string> = {
  "encounter.start": "🟢", "stage.enter": "📄", patient: "🧑", consent: "✅",
  "message.user": "🗣️", "message.assistant": "🤖", "model.io": "⚙️",
  stt: "🎤", tts: "🔊", translation: "🌐", icd: "🏷️", outcome: "🩺",
  signoff: "✍️", note: "📝", "encounter.end": "🔴",
};

function summarize(ev: AuditEvent): string {
  const d = ev.data || {};
  switch (ev.type) {
    case "encounter.start": return `lang=${d.lang ?? "?"}`;
    case "stage.enter": return String(d.name || d.path || "");
    case "patient": return `${d.name ?? "?"} (${d.id ?? "?"})`;
    case "consent": return `understood=${d.understood} sharing=${(d.sharing as string[] | undefined)?.join(",") ?? ""}`;
    case "message.user": return String(d.text || "");
    case "message.assistant": return String(d.text || "");
    case "model.io": return `${d.model} · ${(String(d.content || "")).replace(/<think>[\s\S]*?<\/think>/g, "").slice(0, 80)}…`;
    case "stt": return `“${d.text}” (${d.lang})`;
    case "tts": return `“${String(d.text || "").slice(0, 60)}” [${d.voice ?? ""}]`;
    case "translation": return `${d.from}→${d.to} · ${String(d.src || "").slice(0, 30)} ⇒ ${String(d.out || "").slice(0, 30)}`;
    case "icd": return `${d.condition} → ${d.verified} ${d.description ?? ""}`;
    case "outcome": return `${d.decision ?? ""} ${d.band ?? ""}`;
    case "signoff": return `${d.validatedBy ?? ""} · ${d.decision ?? ""} · ${String(d.hash || "").slice(0, 12)}…`;
    default: return "";
  }
}

export default function Audit() {
  const [encs, setEncs] = useState<EncounterSummary[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => listEncounters().then(setEncs);
  useEffect(() => { reload(); }, []);

  async function open(id: string) {
    setSel(id); setBusy(true); setMsg("");
    const r = await getEncounter(id);
    setEvents(r?.events || []); setIntegrity(r?.integrity || null); setBusy(false);
  }

  async function doExport(id: string) {
    const b = await exportEncounter(id);
    if (!b) { setMsg("export failed"); return; }
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${id}.audit.json`; a.click();
    URL.revokeObjectURL(url);
  }

  async function doImport(file: File) {
    setMsg("");
    try {
      const bundle = JSON.parse(await file.text());
      const res = await importBundle(bundle);
      if (!res) { setMsg("import failed (server error)"); return; }
      setMsg(res.ok
        ? `Imported ${res.encounterId} — integrity ${res.integrity?.ok ? "OK ✓" : "BROKEN ✗"}, signature ${res.signatureOk ? "valid ✓" : "invalid ✗"}${res.imported ? "" : " (already present)"}`
        : `Rejected: ${res.reason || "integrity check failed"}`);
      await reload();
      if (res.encounterId) open(res.encounterId);
    } catch (e) { setMsg(`bad file: ${e instanceof Error ? e.message : String(e)}`); }
  }

  return (
    <>
      <div className="eyebrow">Audit</div>
      <h1>Audit log</h1>
      <p className="lead">Per-patient, append-only, hash-chained record of every step, model exchange,
        translation and decision. Tamper-evident, exportable and verifiable.</p>

      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn ghost" onClick={reload}>↻ Refresh</button>
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>⬆ Import bundle…</button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.currentTarget.value = ""; }} />
      </div>
      {msg && <div className="card note" style={{ marginBottom: 12 }}>{msg}</div>}

      <div className="audit-grid">
        {/* encounter list */}
        <div className="card audit-list">
          <h2>Patients / encounters</h2>
          {!encs.length && <p className="note">No encounters logged yet.</p>}
          {encs.map((e) => (
            <button key={e.encounterId} className={`audit-item${sel === e.encounterId ? " active" : ""}`} onClick={() => open(e.encounterId)}>
              <div className="audit-item-top">
                <span>{e.patient?.name || "(unidentified)"}</span>
                {e.band && <span className={`pill ${e.band}`}>{e.decision || e.band}</span>}
              </div>
              <div className="note">
                {new Date(e.start).toLocaleString()} · {e.events} events · {e.lang || "?"} ·{" "}
                {e.integrity ? <span className="ok">✓ intact</span> : <span className="bad">✗ tampered</span>}
              </div>
              <div className="mono" style={{ fontSize: 11 }}>{e.encounterId}</div>
            </button>
          ))}
        </div>

        {/* timeline */}
        <div className="card audit-detail">
          {!sel && <p className="note">Select an encounter to view its timeline.</p>}
          {sel && (
            <>
              <div className="audit-detail-head">
                <h2 style={{ margin: 0 }}>Timeline</h2>
                {integrity && (
                  <span className={`pill ${integrity.ok ? "GREEN" : "RED"}`}>
                    {integrity.ok ? `✓ verified (${integrity.count} events, chain intact)` : `✗ broken at #${integrity.brokenAt} (${integrity.reason})`}
                  </span>
                )}
                <button className="btn ghost" onClick={() => doExport(sel)}>⬇ Export / share</button>
              </div>
              {busy && <p className="note">loading…</p>}
              <ol className="audit-timeline">
                {events.map((ev) => (
                  <li key={ev.seq} className="audit-ev">
                    <div className="audit-ev-head">
                      <span className="audit-ev-type">{TYPE_ICON[ev.type] || "•"} {ev.type}</span>
                      <span className="note">#{ev.seq} · {new Date(ev.ts).toLocaleTimeString()} · {ev.actor}</span>
                    </div>
                    {summarize(ev) && <div className="audit-ev-sum">{summarize(ev)}</div>}
                    <details>
                      <summary className="note">raw + hash</summary>
                      <pre className="mono audit-raw">{JSON.stringify(ev.data, null, 1)}</pre>
                      <div className="mono" style={{ fontSize: 10 }}>hash {ev.hash.slice(0, 24)}… ← prev {ev.prevHash.slice(0, 16)}…</div>
                    </details>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </>
  );
}
