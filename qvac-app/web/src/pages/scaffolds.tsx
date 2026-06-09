// Pages 1–4 + 7–9 (page 5 Triage and 6 History are their own files). Functional, wired
// into the encounter store. Parts that are simulated for the demo are marked <Badge> so a
// viewer can see exactly what's real vs to-be-productionised.
import type { ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEncounter } from "../store";
import { chat } from "../lib/openai";
import { sha256Hex, newId } from "../lib/sign";
import { VoiceTextarea, SpeakButton } from "../lib/voice";
import { useHelp, TriageResult } from "../lib/ui";
import { useT } from "../lib/prefs";

const Badge = ({ children = "MOCK" }: { children?: ReactNode }) => <span className="badge">{children}</span>;
const Todo = ({ children }: { children: ReactNode }) => <div className="placeholder">{children}</div>;

function Shell({ step, title, lead, children, next, nextLabel = "Continue" }:
  { step: string; title: string; lead?: string; children?: ReactNode; next?: string; nextLabel?: string }) {
  const nav = useNavigate();
  return (
    <>
      <div className="eyebrow">{step}</div>
      <h1>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
      <div className="card">{children}</div>
      {next && <div className="row"><button className="btn block" onClick={() => nav(next)}>{nextLabel} →</button></div>}
    </>
  );
}

export function Identify() {
  const { set, enc } = useEncounter();
  const nav = useNavigate();
  return (
    <>
      <div className="eyebrow">Step 1 · Identify</div>
      <h1>Welcome</h1>
      <p className="lead">Sign in to begin. A practitioner is on hand throughout.</p>
      <div className="card">
        <label htmlFor="n">Your name</label>
        <input id="n" defaultValue={enc.patient?.name || ""} placeholder="Scan card / QR, or type your name"
          onChange={(e) => set({ patient: { id: "MRN-DEMO", name: e.target.value } })} />
        <Todo>Card / QR / biometric → resolve hospital MRN (the PII anchor / patient identity). <Badge>to productionise</Badge></Todo>
        <div className="row"><button className="btn block" onClick={() => nav("/consent")} disabled={!enc.patient?.name}>Continue →</button></div>
      </div>
    </>
  );
}

const CONSENT_SPOKEN =
  "This assistant supports a pharmacist — it does not replace a doctor, and a practitioner reviews the result. " +
  "You can stop anytime. If your case is urgent we'll retrieve your hospital record. " +
  "Your result may be shared with the pharmacy, hospital, or paramedics as needed.";

export function Consent() {
  const { set } = useEncounter();
  const nav = useNavigate();
  const { openHelp } = useHelp();
  const [teachback, setTeachback] = useState("");
  return (
    <>
      <div className="eyebrow">Step 2 · Consent &amp; capacity</div>
      <h1>Before we start</h1>
      <p className="lead">This assistant supports a pharmacist — it does <strong>not</strong> replace a doctor, and a
        practitioner reviews the result. You can stop anytime. If your case is urgent we'll retrieve your hospital
        record. Your result may be shared with the pharmacy, hospital, or paramedics as needed.</p>
      <div className="row"><SpeakButton text={CONSENT_SPOKEN} label="Read this aloud" /></div>
      <div className="card">
        <label htmlFor="tb">In your own words, what is this and can you stop it?</label>
        <VoiceTextarea value={teachback} onChange={setTeachback} id="tb"
          placeholder="e.g. it's a helper that asks me questions, a real person checks it, and I can stop whenever…" />
        <p className="note">Teach-back: we record your understanding (consent evidence). If you're unsure, ask for help —
          you'll go to a person instead. <Badge>LLM-graded in production</Badge></p>
        <div className="row">
          <button className="btn ghost" onClick={() => openHelp(false)}>I have questions / need help</button>
          <button className="btn" disabled={teachback.trim().length < 8}
            onClick={() => { set({ consent: { understood: true, sharing: ["pharmacy", "hospital", "paramedics"] } }); nav("/context"); }}>
            I understand &amp; agree →
          </button>
        </div>
      </div>
    </>
  );
}

export function Context() {
  const { enc, setSituation } = useEncounter();
  return (
    <Shell step="Step 3 · Context" title="What brings you in?" next="/intake"
      lead="A one-line reason for your visit. No medical record is opened yet.">
      <label htmlFor="cc">Presenting complaint</label>
      <VoiceTextarea value={enc.situation.complaint} id="cc"
        placeholder="e.g. chest discomfort for the last hour"
        onChange={(v) => setSituation({ complaint: v })} />
      <p className="note">This becomes the <em>situation</em> identity for this episode.</p>
    </Shell>
  );
}

export function Intake() {
  const { enc, setSituation } = useEncounter();
  const T = useT();
  const add = (s: string) => setSituation({ intake: enc.situation.intake ? `${enc.situation.intake}; ${s}` : s });
  return (
    <Shell step="Step 4 · Intake" title="A few details" next="/triage" nextLabel="Begin triage"
      lead="Type, tap 🎤 to speak, or use a quick answer below. Tell us your medicines, conditions and allergies — this keeps triage safe without opening your full record.">
      <label htmlFor="hx">Current medicines, conditions, allergies</label>
      <VoiceTextarea value={enc.situation.intake} id="hx"
        placeholder="e.g. on warfarin; penicillin allergy; type-2 diabetes"
        onChange={(v) => setSituation({ intake: v })} />
      <div className="chips">
        <button type="button" className="chip" onClick={() => add(T("none.meds"))}>{T("none.meds")}</button>
        <button type="button" className="chip" onClick={() => add(T("none.allergies"))}>{T("none.allergies")}</button>
        <button type="button" className="chip" onClick={() => add(T("dontknow"))}>{T("dontknow")}</button>
      </div>
      <Todo>🎤 On-device speech (Nemotron-3.5-ASR) is live · 📷 camera for visual red-flags still to come. <Badge>to productionise</Badge> This is the <strong>patient-reported history</strong> layer.</Todo>
    </Shell>
  );
}

export function Route() {
  const { enc } = useEncounter();
  const nav = useNavigate();
  const o = enc.outcome;
  const band = o?.band || "";
  const dest = band === "RED" ? "Emergency dept / EMS — paging the attending now"
    : band === "AMBER" ? "Same-day GP/nurse — auto-booking a slot"
    : band === "GREEN" ? "Pharmacist-led care — queued with a safety-net"
    : "Pending triage";
  const recipient = band === "RED" ? "Paramedics + attending" : band === "AMBER" ? "Duty GP/nurse" : "Pharmacist";
  const [sbar, setSbar] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function handover() {
    if (!o) return;
    setBusy(true);
    try {
      const text = await chat([
        { role: "system", content: "Write a concise clinical handover in SBAR format (Situation, Background, Assessment, Recommendation), four short labelled lines, no preamble." },
        { role: "user", content: `Decision ${o.decision}, severity ${o.severity}. Condition: ${o.condition}. Red flags: ${o.redFlags}. Routing: ${o.routing}. Safety-net: ${o.safetyNet}.` },
      ]);
      setSbar(text);
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="eyebrow">Step 7 · Route &amp; notify</div>
      <h1>Where this goes</h1>
      <div className="card">
        {band && <p><span className={`pill ${band}`}>{o?.decision}</span></p>}
        <p className="v" style={{ fontSize: 18, fontWeight: 600 }}>{dest}</p>
        {!sbar ? (
          <div className="row"><button className="btn" onClick={handover} disabled={!o || busy}>{busy ? "Drafting handover…" : "Generate SBAR handover"}</button></div>
        ) : (
          <>
            <div className="k" style={{ marginTop: 12 }}>SBAR handover</div>
            <div className="sbar" style={{ marginTop: 6 }}>{sbar}</div>
            <div className="row">
              <button className="btn" onClick={() => setSent(true)} disabled={sent}>
                {sent ? `✅ Notified: ${recipient}` : `Notify ${recipient}`}
              </button>
            </div>
            {sent && <p className="note">Notification delivered <Badge>mock send</Badge> — production: EHR task inbox / pager / secure message.</p>}
          </>
        )}
      </div>
      <div className="row"><button className="btn block ghost" onClick={() => nav("/validate")}>Send for validation →</button></div>
    </>
  );
}

export function Validate() {
  const { enc, set } = useEncounter();
  const nav = useNavigate();
  const o = enc.outcome;
  const [decision, setDecision] = useState(o?.decision || "");
  const [severity, setSeverity] = useState((o?.severity.match(/\d+/) || [""])[0]);
  const [notes, setNotes] = useState("");
  const [record, setRecord] = useState<{ id: string; hash: string; at: string } | null>(null);

  async function signOff() {
    const payload = {
      patient: enc.patient?.id || "MRN-DEMO",
      situation: { id: newId("ENC"), complaint: enc.situation.complaint },
      outcome: { id: newId("OUT"), decision, severity, condition: o?.condition, icd: o?.icd, routing: o?.routing },
      validatedBy: "Dr. on-shift (demo)",
      at: new Date().toISOString(),
      notes,
    };
    const hash = await sha256Hex(JSON.stringify(payload));
    setRecord({ id: payload.outcome.id, hash, at: payload.at });
    set({ outcome: o ? { ...o, decision, severity } : o });
  }

  return (
    <>
      <div className="eyebrow">Step 8 · Validation</div>
      <h1>Practitioner sign-off</h1>
      <p className="lead">The always-signed-in clinician reviews, edits, and confirms — the human-in-the-loop gate.</p>
      {o && <div style={{ marginBottom: 16 }}><TriageResult t={o} view="clinician" /></div>}
      <div className="card">
        <label>Decision</label>
        <select value={decision} onChange={(e) => setDecision(e.target.value)}>
          {["EMERGENCY", "URGENT", "PHARMACIST-LED", "ROUTINE", "INSUFFICIENT-DATA"].map((d) => <option key={d}>{d}</option>)}
        </select>
        <label>Severity (0–10)</label>
        <input value={severity} onChange={(e) => setSeverity(e.target.value)} />
        <label>Clinician note (optional)</label>
        <VoiceTextarea value={notes} onChange={setNotes} placeholder="Any change or rationale…" />
        <div className="row"><button className="btn" onClick={signOff}>Confirm &amp; sign</button></div>

        {record && (
          <div style={{ marginTop: 14 }}>
            <div className="k">Signed outcome record <Badge>SHA-256 (ECDSA in prod)</Badge></div>
            <p className="v">Immutable &amp; tamper-evident — patient / situation / outcome identities + clinician + time.</p>
            <p className="mono">outcome_id: {record.id}<br />signed_at: {record.at}<br />sha256: {record.hash}</p>
          </div>
        )}
      </div>
      {record && <div className="row"><button className="btn block" onClick={() => nav("/billing")}>Confirm &amp; code →</button></div>}
    </>
  );
}

export function Billing() {
  const { enc } = useEncounter();
  const o = enc.outcome;
  const [icd, setIcd] = useState<{ code: string; description: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [claim, setClaim] = useState<Record<string, string> | null>(null);

  async function generate() {
    setBusy(true);
    try {
      let code = icd;
      if (!code && o?.condition) {
        const r = await fetch("/api/icd", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ condition: o.condition }) });
        code = (await r.json()).results?.[0] || null;
        setIcd(code);
      }
      setClaim({
        encounter: newId("ENC"),
        diagnosis: o?.condition || "—",
        icd10: code?.code || o?.icd || "—",
        urgency: o?.decision || "—",
        eligibility: "Active (verified)",
      });
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="eyebrow">Step 9 · Code &amp; bill</div>
      <h1>Coding &amp; billing</h1>
      <p className="lead">From the <strong>validated</strong> diagnosis — not the AI draft.</p>
      <div className="card">
        <div className="field"><div className="k">Working diagnosis</div><div className="v">{o?.condition || "—"}</div></div>
        <div className="row"><button className="btn" onClick={generate} disabled={!o || busy}>{busy ? "Grounding code & drafting claim…" : "Generate claim"}</button></div>
        {claim && (
          <div style={{ marginTop: 14 }}>
            <div className="field"><div className="k">Encounter</div><div className="v mono">{claim.encounter}</div></div>
            <div className="field"><div className="k">ICD-10 (verified on-device)</div><div className="v"><span className="pill GREEN">✓ {claim.icd10}</span> {icd?.description || ""}</div></div>
            <div className="field"><div className="k">Eligibility (X12 270/271)</div><div className="v">{claim.eligibility} <Badge>mock payer</Badge></div></div>
            <div className="field"><div className="k">Claim (X12 837)</div><div className="v">Draft assembled <Badge>mock</Badge> — awaiting coder sign-off &amp; submission.</div></div>
          </div>
        )}
        <Todo>Production: real eligibility (270/271) + claim (837) to the payer; write the validated outcome + codes back to the EHR, audit-logged.</Todo>
      </div>
    </>
  );
}
