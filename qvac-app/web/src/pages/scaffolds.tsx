// The 8 non-triage pages — scaffolds mapped 1:1 to ARCHITECTURE.md, ready to expand.
// Where it helps the demo flow they read/write the encounter store.
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useEncounter } from "../store";

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

const Todo = ({ children }: { children: ReactNode }) => <div className="placeholder">{children}</div>;

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
        <Todo>Production: card / QR / biometric → resolve hospital MRN (the PII anchor / patient identity).</Todo>
        <div className="row"><button className="btn block" onClick={() => nav("/consent")} disabled={!enc.patient?.name}>Continue →</button></div>
      </div>
    </>
  );
}

export function Consent() {
  const { set } = useEncounter();
  const nav = useNavigate();
  return (
    <>
      <div className="eyebrow">Step 2 · Consent &amp; capacity</div>
      <h1>Before we start</h1>
      <p className="lead">This assistant supports a pharmacist — it does <strong>not</strong> replace a doctor, and a
        practitioner reviews the result. You can stop anytime. If your case is urgent, we'll retrieve your hospital
        record. Your result may be shared with the pharmacy, hospital, or paramedics as needed.</p>
      <div className="card">
        <Todo>Production: <strong>teach-back</strong> — the patient restates this in their own words to verify
          understanding (a short multi-step dialogue). If understanding isn't shown → assist &amp; retry, then the
          separate human/proxy pathway. The AI flags capacity concerns; a human decides. Care is never gated by consent
          in an emergency.</Todo>
        <div className="row">
          <button className="btn ghost" onClick={() => alert("Routes to the human/proxy pathway (to build).")}>I have questions / need help</button>
          <button className="btn" onClick={() => { set({ consent: { understood: true, sharing: ["pharmacy", "hospital", "paramedics"] } }); nav("/context"); }}>I understand &amp; agree →</button>
        </div>
      </div>
    </>
  );
}

export function Context() {
  const { enc, setSituation } = useEncounter();
  const nav = useNavigate();
  return (
    <Shell step="Step 3 · Context" title="What brings you in?" next="/intake"
      lead="A one-line reason for your visit. No medical record is opened yet.">
      <label htmlFor="cc">Presenting complaint</label>
      <textarea id="cc" defaultValue={enc.situation.complaint}
        placeholder="e.g. chest discomfort for the last hour"
        onChange={(e) => setSituation({ complaint: e.target.value })} />
      <p className="note">This becomes the <em>situation</em> identity for this episode.</p>
    </Shell>
  );
}

export function Intake() {
  const { enc, setSituation } = useEncounter();
  return (
    <Shell step="Step 4 · Intake" title="A few details" next="/triage" nextLabel="Begin triage"
      lead="Answer by typing now (voice/STT and camera red-flags coming next). Tell us your medicines, conditions and allergies — this keeps triage safe without opening your full record.">
      <label htmlFor="hx">Current medicines, conditions, allergies</label>
      <textarea id="hx" defaultValue={enc.situation.intake}
        placeholder="e.g. on warfarin; penicillin allergy; type-2 diabetes"
        onChange={(e) => setSituation({ intake: e.target.value })} />
      <Todo>Production: 🔊 TTS reads each prompt · 🎤 STT captures spoken answers · 📷 optional camera for visual red-flags. This is the <strong>patient-reported history</strong> layer.</Todo>
    </Shell>
  );
}

export function Route() {
  const { enc } = useEncounter();
  const band = enc.outcome?.band || "";
  const dest = band === "RED" ? "Emergency dept / EMS — paging the attending now"
    : band === "AMBER" ? "Same-day GP/nurse — auto-booking a slot"
    : band === "GREEN" ? "Pharmacist-led care — queued with a safety-net"
    : "Pending triage";
  return (
    <Shell step="Step 7 · Route & notify" title="Where this goes" next="/validate" nextLabel="Send for validation">
      {band && <p><span className={`pill ${band}`}>{enc.outcome?.decision}</span></p>}
      <p className="v" style={{ fontSize: 18, fontWeight: 600 }}>{dest}</p>
      <Todo>Production: notify the right person (EHR task inbox / pager / secure message) with the structured triage +
        verified code. 🔴 fires immediately (validation concurrent); 🟡/🟢 queue and validate before treatment.</Todo>
    </Shell>
  );
}

export function Validate() {
  return (
    <Shell step="Step 8 · Validation" title="Practitioner sign-off" next="/billing" nextLabel="Confirm & code">
      <Todo>Production: the always-signed-in clinician reviews, edits, and confirms the outcome — the human-in-the-loop
        gate. The validated diagnosis becomes the <strong>outcome</strong> identity (immutable, signed, audit-logged).
        The 🔴 safety floor does not wait on this.</Todo>
    </Shell>
  );
}

export function Billing() {
  const { enc } = useEncounter();
  return (
    <Shell step="Step 9 · Code & bill" title="Coding & billing" >
      <p className="note">From the <strong>validated</strong> diagnosis — not the AI draft.</p>
      <div className="field"><div className="k">Working diagnosis</div><div className="v">{enc.outcome?.condition || "—"}</div></div>
      <div className="field"><div className="k">ICD-10 (verify on-device)</div><div className="v">{enc.outcome?.icd || "—"}</div></div>
      <Todo>Production: ground the final ICD-10 (on-device index), assemble the claim (X12 837); eligibility (270/271)
        runs async. Write the validated outcome + codes back to the EHR, audit-logged.</Todo>
      <p className="note" style={{ marginTop: 14 }}>End of encounter.</p>
    </Shell>
  );
}
