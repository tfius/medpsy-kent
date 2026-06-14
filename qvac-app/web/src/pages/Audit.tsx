// Audit viewer — per-patient log: list → timeline, integrity verification, export
// (signed bundle) for sharing, and import (verify + view) of a shared bundle.
// Clinician/audit view; kept in canonical English.
import { useEffect, useRef, useState } from "react";
import {
  listEncounters, getEncounter, exportEncounter, importBundle,
  p2pSend, p2pReceive, p2pStatus,
  type AuditEvent, type EncounterSummary, type Integrity, type P2pOfferStatus,
} from "../lib/audit";
import { getEncounterOKF, downloadOkfBundle, type OkfEncounter } from "../lib/okf";

const TYPE_ICON: Record<string, string> = {
  "encounter.start": "🟢", "stage.enter": "📄", patient: "🧑", consent: "✅",
  "message.user": "🗣️", "message.assistant": "🤖", "model.io": "⚙️",
  stt: "🎤", tts: "🔊", translation: "🌐", icd: "🏷️", outcome: "🩺", "knowledge.search": "📚",
  "agent.user": "💬", "agent.tool": "🔧", "agent.answer": "🤖",
  "atriage.reasoning": "🧠", "atriage.tool": "🔧", "atriage.tool_result": "📊",
  "atriage.question": "❓", "atriage.error": "⚠️",
  "facts.read": "📂", "facts.assert": "🧾",
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
    case "stt": return `“${d.text}” (${d.lang}${d.locale && d.locale !== d.lang ? `→${d.locale}` : ""})`;
    case "tts": return `“${String(d.text || "").slice(0, 60)}” [${d.voice ?? ""}]`;
    case "translation": return `${d.from}→${d.to} · ${String(d.src || "").slice(0, 30)} ⇒ ${String(d.out || "").slice(0, 30)}`;
    case "icd": return `${d.condition} → ${d.verified} ${d.description ?? ""}`;
    case "knowledge.search": return `${String(d.query || "").slice(0, 40)} → ${((d.results as { doc: string }[] | undefined) || []).map((r) => r.doc).join(", ")}`;
    case "agent.user": return String(d.text || "");
    case "agent.tool": return `${d.name}(${Object.values((d.args as Record<string, unknown>) || {}).map(String).join(", ").slice(0, 40)})`;
    case "agent.answer": return String(d.text || "").slice(0, 80);
    case "atriage.reasoning": return String(d.text || "").slice(0, 80);
    case "atriage.tool": return `${d.name}(${Object.values((d.args as Record<string, unknown>) || {}).map(String).join(", ").slice(0, 40)})`;
    case "atriage.tool_result": return `${d.name} → ${JSON.stringify(d.result).slice(0, 60)}`;
    case "atriage.question": return String(d.text || "").slice(0, 80);
    case "atriage.error": return String(d.error || "").slice(0, 80);
    case "facts.read": return `${d.tool} → ${((d.statements as { statementId: string }[] | undefined) || []).length} fact(s)`;
    case "facts.assert": return `${d.tool} · ${String(d.statementId || "").slice(0, 16)}`;
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
  const [okf, setOkf] = useState<OkfEncounter | null>(null); // lossy OKF view of the selected encounter
  const fileRef = useRef<HTMLInputElement>(null);
  // P2P handoff state: an active outgoing offer, and the receive-code input.
  const [offer, setOffer] = useState<P2pOfferStatus | null>(null);
  const [recvCode, setRecvCode] = useState<string | null>(null); // null = closed, "" = open+empty
  const [recvBusy, setRecvBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  const reload = () => listEncounters().then(setEncs);
  useEffect(() => { reload(); }, []);
  useEffect(() => stopPoll, []); // clear any live offer poll on unmount

  async function open(id: string) {
    setSel(id); setBusy(true); setMsg(""); setOkf(null);
    const r = await getEncounter(id);
    setEvents(r?.events || []); setIntegrity(r?.integrity || null); setBusy(false);
  }

  // Lossy, human-readable OKF view of the encounter (NOT the audit record — the signed
  // bundle is). For OKF tooling / quick reading.
  async function doOkfView(id: string) {
    setMsg("");
    const r = await getEncounterOKF(id);
    if (!r) { setMsg("OKF view failed"); return; }
    setOkf(r);
  }

  async function doExport(id: string) {
    const b = await exportEncounter(id);
    if (!b) { setMsg("export failed"); return; }
    const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${id}.audit.json`; a.click();
    URL.revokeObjectURL(url);
  }

  // Offer the selected encounter over P2P, then poll until it's picked up / expires.
  async function doSend(id: string) {
    setMsg(""); stopPoll();
    const o = await p2pSend(id);
    if (!o || !("code" in o)) { setMsg(`P2P send failed: ${(o as { error?: string })?.error || "is the API server running?"}`); return; }
    setOffer({ ...o, createdAt: "", status: "waiting", sentTo: null, error: null });
    pollRef.current = setInterval(async () => {
      const s = (await p2pStatus())?.offers.find((x) => x.code === o.code);
      if (!s) { stopPoll(); return; } // offer gone (e.g. server restart) — stop polling
      setOffer(s);
      if (s.status !== "waiting") stopPoll();
    }, 2000);
  }

  async function doReceive(code: string) {
    setRecvBusy(true); setMsg("");
    const r = await p2pReceive(code);
    setRecvBusy(false); setRecvCode(null);
    if (!r) { setMsg("Nothing received — check the code and that the sender is still offering."); return; }
    // Attribute to the VERIFIED signer (signedBy, bound to the ed25519 key we checked),
    // not r.sender — that's the wire peer's self-claimed, unauthenticated name.
    const signer = r.signedBy?.name || (r.signedBy?.publicKey ? `${r.signedBy.publicKey.slice(0, 12)}…` : "unknown device");
    setMsg(r.ok
      ? `Received ${r.encounterId} from ${signer} — integrity ${r.integrity?.ok ? "OK ✓" : "BROKEN ✗"}, device signature ${r.signatureOk ? `valid ✓ (${r.signedBy?.scheme})` : "invalid ✗"}${r.imported ? "" : " (already present)"}`
      : `Rejected: ${r.reason || r.error || "integrity check failed"}`);
    await reload();
    if (r.encounterId) open(r.encounterId);
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
        <button className="btn ghost" onClick={() => setRecvCode(recvCode === null ? "" : null)}>📡 Receive from device…</button>
      </div>
      {recvCode !== null && (
        <div className="card" style={{ marginBottom: 12 }}>
          <b>Receive a handoff</b>{" "}
          <span className="note">— enter the pairing code shown on the sending device</span>
          <div className="row" style={{ marginTop: 8 }}>
            <input className="mono" value={recvCode} placeholder="XXXX-XXXX" autoFocus
              onChange={(e) => setRecvCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter" && recvCode && !recvBusy) doReceive(recvCode); }} />
            <button className="btn" disabled={!recvCode || recvBusy} onClick={() => doReceive(recvCode)}>
              {recvBusy ? "listening…" : "Receive"}
            </button>
          </div>
          {recvBusy && <p className="note" style={{ marginBottom: 0 }}>Waiting for the sending device (encrypted device-to-device transfer)…</p>}
        </div>
      )}
      {offer && (
        <div className="card" style={{ marginBottom: 12 }}>
          📡 Offering <span className="mono">{offer.encounterId}</span> — pairing code{" "}
          <b className="mono" style={{ fontSize: 18 }}>{offer.code}</b>{" "}
          {offer.status === "waiting" && <span className="note">enter this code on the receiving device (expires {new Date(offer.expiresAt).toLocaleTimeString()})</span>}
          {offer.status === "sent" && <span className="ok">✓ delivered to “{offer.sentTo?.name || "device"}”</span>}
          {offer.status === "rejected" && <span className="bad">✗ receiver rejected: {offer.error}</span>}
          {(offer.status === "expired" || offer.status === "cancelled") && <span className="bad">offer {offer.status}</span>}
          {" "}<button className="btn ghost" onClick={() => { stopPoll(); setOffer(null); }}>dismiss</button>
        </div>
      )}
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
                <button className="btn ghost" onClick={() => doSend(sel)}>📡 Send to device</button>
                <button className="btn ghost" onClick={() => doOkfView(sel)}>📄 OKF view</button>
              </div>

              {okf && okf.encounterId === sel && (
                <div className="card" style={{ marginTop: 8 }}>
                  <div className="row" style={{ alignItems: "center" }}>
                    <strong>OKF view</strong>
                    <span className="pill AMBER">non-authoritative</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn ghost" onClick={() => downloadOkfBundle(sel, okf.files)}>⬇ Download .okf.json</button>
                    <button className="btn ghost" onClick={() => setOkf(null)}>✕ Close</button>
                  </div>
                  <p className="note">Human-readable Open Knowledge Format rendering for OKF tooling. The tamper-evident
                    record of truth is the signed bundle above (Export / share), not this.</p>
                  <pre className="mono audit-raw" style={{ whiteSpace: "pre-wrap" }}>
                    {okf.files[`encounter/${sel}.md`] || Object.values(okf.files)[0]}
                  </pre>
                </div>
              )}
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
