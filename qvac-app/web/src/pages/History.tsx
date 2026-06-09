import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { chat } from "../lib/openai";
import { refine, parseTriage, type Triage } from "../lib/triage";
import { getMockEhr, ehrText, type EhrRecord } from "../lib/mockEhr";
import { useEncounter } from "../store";
import { TriageResult, useHelp } from "../lib/ui";

// Step 6 — conditional history. For urgent/severe cases, retrieve the authoritative
// record and RE-TRIAGE: the record can add precautions or escalate. Routine cases skip.
export default function History() {
  const { enc, set } = useEncounter();
  const nav = useNavigate();
  const { openHelp } = useHelp();
  const original = enc.outcome;
  const urgent = !!original && original.band !== "GREEN";

  const [ehr, setEhr] = useState<EhrRecord | null>(null);
  const [refined, setRefined] = useState<Triage | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function reTriage(record: EhrRecord) {
    setBusy(true); setErr("");
    try {
      const reply = await chat(refine(enc.situation.complaint, enc.situation.intake, ehrText(record)));
      const t = parseTriage(reply);
      setRefined(t);
      set({ outcome: t }); // the refined outcome carries forward
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="eyebrow">Step 6 · History</div>
      <h1>Hospital record</h1>

      {!urgent ? (
        <>
          <p className="lead">Routine case — the full record is <strong>not</strong> opened (data minimisation). Patient-reported history already informed the triage.</p>
          <div className="row"><button className="btn block" onClick={() => nav("/route")}>Continue → routing</button></div>
        </>
      ) : (
        <>
          <p className="lead">Urgent/severe case — retrieve the authoritative record (FHIR) and re-triage with interactions, comorbidities and allergies.</p>

          {!ehr ? (
            <div className="card">
              <div className="placeholder">Mock FHIR fetch over the hospital LAN. In production this pulls the real record for {enc.patient?.name || "the patient"}.</div>
              <div className="row"><button className="btn block" onClick={() => setEhr(getMockEhr(enc.patient?.name))}>Retrieve hospital record</button></div>
            </div>
          ) : (
            <div className="card">
              <div className="field"><div className="k">Medications</div><div className="v">{ehr.meds.join(", ")}</div></div>
              <div className="field"><div className="k">Conditions</div><div className="v">{ehr.conditions.join(", ")}</div></div>
              <div className="field"><div className="k">Allergies</div><div className="v">{ehr.allergies.join(", ")}</div></div>
              <div className="row">
                <button className="btn block" onClick={() => reTriage(ehr)} disabled={busy}>
                  {busy ? "Re-triaging with history…" : "Re-triage with history"}
                </button>
              </div>
            </div>
          )}

          {err && <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>⚠ {err}</div>}

          {refined && original && (
            <>
              <div className="card">
                <div className="k">Triage updated by history</div>
                <div className="v" style={{ marginTop: 6 }}>
                  <span className={`pill ${original.band || "AMBER"}`}>{original.decision} · {sev(original)}</span>
                  {"  →  "}
                  <span className={`pill ${refined.band || "AMBER"}`}>{refined.decision} · {sev(refined)}</span>
                  {changed(original, refined) ? "" : <span className="note"> (unchanged)</span>}
                </div>
              </div>
              <TriageResult t={refined} view="patient" onNext={() => nav("/route")} onEmergency={() => openHelp(true)} />
            </>
          )}
        </>
      )}
    </>
  );
}

const sev = (t: Triage) => `sev ${(t.severity.match(/\d+/) || ["?"])[0]}`;
const changed = (a: Triage, b: Triage) => a.band !== b.band || (a.severity.match(/\d+/)?.[0] !== b.severity.match(/\d+/)?.[0]);
