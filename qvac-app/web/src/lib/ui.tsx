// Shared UI: accessible modal, the app-wide Help/Emergency system, triage-band
// helpers, and the unified TriageResult (patient vs clinician views).
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useT, usePrefs, LANGS } from "./prefs";
import { audit as auditLog } from "./audit";
import type { Triage } from "./triage";

// Segmented language picker (start-of-session choice; lives on the welcome step).
// Fully-supported languages sit on the first line; languages without a native voice
// yet (beta) are set apart on a second line with a note.
export function LanguagePicker() {
  const { lang, setLang } = usePrefs();
  const opt = (l: typeof LANGS[number]) => (
    <button key={l.code} type="button" aria-pressed={lang === l.code}
      className={`lang-opt${lang === l.code ? " active" : ""}`} onClick={() => setLang(l.code)}>
      <span className="flag" aria-hidden="true">{l.flag}</span>
      <span className="name">{l.label}</span>
    </button>
  );
  const limited = LANGS.filter((l) => l.limited);
  return (
    <div className="lang-picker-wrap" role="group" aria-label="Language">
      <div className="lang-picker">{LANGS.filter((l) => !l.limited).map(opt)}</div>
      {limited.length > 0 && (
        <div className="lang-picker limited">
          {limited.map(opt)}
          <span className="lang-note">🔊 voice not available yet</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Modal
export function Modal({ title, onClose, children }:
  { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}
        tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// -------------------------------------------------- Help / Emergency (app-wide)
type HelpCtx = { openHelp: (emergency?: boolean) => void };
const Ctx = createContext<HelpCtx | null>(null);
export function useHelp(): HelpCtx {
  return useContext(Ctx) ?? { openHelp: () => {} };
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const T = useT();
  const [open, setOpen] = useState(false);
  const [emergency, setEmergency] = useState(false);
  const [calling, setCalling] = useState(false);
  const openHelp = (em = false) => { setEmergency(em); setCalling(false); setOpen(true); };
  const close = () => setOpen(false);
  return (
    <Ctx.Provider value={{ openHelp }}>
      {children}
      {open && (
        <Modal title={emergency ? T("help.emergencyTitle") : T("help.title")} onClose={close}>
          {!emergency && <p className="help-ok">✅ {T("help.notified")}</p>}
          <div className="help-emergency">
            <p>{T("help.emergencyBody")}</p>
            {calling
              ? <p className="help-calling" role="status">📞 {T("help.call")}…</p>
              : <button className="btn danger block" onClick={() => setCalling(true)}>📞 {T("help.call")}</button>}
          </div>
          <div className="row"><button className="btn ghost block" onClick={close}>{T("help.close")}</button></div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

// Topbar "Get help" button.
export function HelpButton() {
  const T = useT();
  const { openHelp } = useHelp();
  return (
    <button type="button" className="btn danger help-btn" aria-label={T("help.aria")} onClick={() => openHelp(false)}>
      🆘 {T("help")}
    </button>
  );
}

// ------------------------------------------------------------- triage bands
export const BAND_ICON: Record<string, string> = { RED: "🛑", AMBER: "⏱️", GREEN: "✅" };

// ICD-10 grounded on-device: verified code for the named condition (clinician view).
function IcdField({ condition, guess }: { condition: string; guess: string }) {
  const [verified, setVerified] = useState<{ code: string; description: string } | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");
  useEffect(() => {
    if (!condition) { setState("err"); return; }
    let cancelled = false;
    fetch("/api/icd", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ condition }) })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const top = d.results?.[0];
        if (top) { setVerified(top); setState("ok"); auditLog.icd({ condition, guess, verified: top.code, description: top.description }); }
        else setState("err");
      })
      .catch(() => !cancelled && setState("err"));
    return () => { cancelled = true; };
  }, [condition]);
  const guessCode = (guess.match(/[A-TV-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?/) || [""])[0];
  const mismatch = verified && guessCode && guessCode.replace(".", "") !== verified.code.replace(".", "");
  return (
    <div className="field">
      <div className="k">ICD-10 — verified on-device</div>
      {state === "loading" && <div className="v note">grounding against the on-device ICD-10 index…</div>}
      {state === "err" && <div className="v">{guess || "—"} <span className="note">(lookup unavailable)</span></div>}
      {state === "ok" && verified && (
        <div className="v">
          <span className="pill GREEN">✓ {verified.code}</span> {verified.description}
          {mismatch && <div className="note" style={{ marginTop: 4 }}>medpsy guessed <s>{guessCode}</s> — replaced with the verified code</div>}
        </div>
      )}
    </div>
  );
}

const Field = ({ k, v }: { k: string; v: string }) => (
  <div className="field"><div className="k">{k}</div><div className="v">{v || "—"}</div></div>
);

// One result component, two audiences. Patient: urgency + plain action, no jargon.
// Clinician: full structured detail incl. verified ICD.
export function TriageResult({ t, view, onNext, nextLabel, onEmergency }:
  { t: Triage; view: "patient" | "clinician"; onNext?: () => void; nextLabel?: string; onEmergency?: () => void }) {
  const T = useT();
  const band = t.band || "AMBER";

  if (view === "patient") {
    return (
      <div className="result" role="status">
        <div className={`banner ${band}`}><span aria-hidden="true">{BAND_ICON[band]}</span>{T(`band.${band}`)}</div>
        <div className="body">
          <Field k={T("result.do")} v={t.routing} />
          <Field k={T("result.watch")} v={t.safetyNet} />
          {band === "RED" && onEmergency && (
            <div className="row"><button className="btn danger block" onClick={onEmergency}>📞 {T("help.call")}</button></div>
          )}
          {onNext && band !== "RED" && (
            <div className="row"><button className="btn block" onClick={onNext}>{nextLabel || T("result.next")} →</button></div>
          )}
        </div>
      </div>
    );
  }

  const sev = (t.severity.match(/\d+/) || ["?"])[0];
  return (
    <div className="result">
      <div className={`banner ${band}`}>
        <span aria-hidden="true">{BAND_ICON[band]}</span>{t.decision || "TRIAGE"}
        <span className="sev">Severity {sev}/10 · {band}</span>
      </div>
      <div className="body">
        <Field k="Red flags" v={t.redFlags || "none identified"} />
        <Field k="Working diagnosis" v={t.condition} />
        <IcdField condition={t.condition} guess={t.icd} />
        <Field k="Routing" v={t.routing} />
        <Field k="Safety-net" v={t.safetyNet} />
        {onNext && <div className="row"><button className="btn block" onClick={onNext}>{nextLabel || "Continue"} →</button></div>}
      </div>
    </div>
  );
}
