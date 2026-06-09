import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { chat } from "../lib/openai";
import { refine, parseTriage, type Triage } from "../lib/triage";
import { getMockEhr, ehrText, type EhrRecord } from "../lib/mockEhr";
import { useEncounter } from "../store";
import { TriageResult, useHelp } from "../lib/ui";
import { useT } from "../lib/prefs";

// Step 6 — conditional history. For urgent/severe cases, retrieve the authoritative
// record and RE-TRIAGE: the record can add precautions or escalate. Routine cases skip.
export default function History() {
  const { enc, set } = useEncounter();
  const nav = useNavigate();
  const { openHelp } = useHelp();
  const T = useT();
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
      <div className="eyebrow">{T("his.eyebrow")}</div>
      <h1>{T("his.title")}</h1>

      {!urgent ? (
        <>
          <p className="lead">{T("his.routineLead")}</p>
          <div className="row"><button className="btn block" onClick={() => nav("/route")}>{T("his.continueRouting")} →</button></div>
        </>
      ) : (
        <>
          <p className="lead">{T("his.urgentLead")}</p>

          {!ehr ? (
            <div className="card">
              <div className="placeholder">Mock FHIR fetch over the hospital LAN. In production this pulls the real record for {enc.patient?.name || "the patient"}.</div>
              <div className="row"><button className="btn block" onClick={() => setEhr(getMockEhr(enc.patient?.name))}>{T("his.retrieve")}</button></div>
            </div>
          ) : (
            <div className="card">
              <div className="field"><div className="k">{T("his.meds")}</div><div className="v">{ehr.meds.join(", ")}</div></div>
              <div className="field"><div className="k">{T("his.conditions")}</div><div className="v">{ehr.conditions.join(", ")}</div></div>
              <div className="field"><div className="k">{T("his.allergies")}</div><div className="v">{ehr.allergies.join(", ")}</div></div>
              <div className="row">
                <button className="btn block" onClick={() => reTriage(ehr)} disabled={busy}>
                  {busy ? T("his.retriaging") : T("his.retriage")}
                </button>
              </div>
            </div>
          )}

          {err && <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>⚠ {err}</div>}

          {refined && original && (
            <>
              <div className="card">
                <div className="k">{T("his.updated")}</div>
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
