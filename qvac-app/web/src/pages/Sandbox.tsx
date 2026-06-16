// Pharmacist-training sandbox — pick (or write) a simulated case, commit to a disposition, then
// reveal: your call graded against the clinician-authored answer (under-triage is the failure that
// matters), the AI's independent assessment, and the safety-review critique. Training runs never
// touch the real record. Turns our safety gate into a teaching tool — grounded, unlike a sim canvas.
import { useEffect, useRef, useState } from "react";
import { TRAINING_CASES, grade, bandOf, runAiAssessment, type TrainingCase, type Disposition, type Grade } from "../lib/sandbox";
import type { TriageOutcome } from "../lib/atriage";

const DISPOSITIONS: Disposition[] = ["EMERGENCY", "URGENT", "PHARMACIST-LED", "ROUTINE"];
const pillFor = (d?: string) => d === "EMERGENCY" ? "RED" : d === "URGENT" || d === "INSUFFICIENT-DATA" ? "AMBER" : "GREEN";

export default function Sandbox() {
  const [sel, setSel] = useState<TrainingCase | null>(TRAINING_CASES[0]);
  const [custom, setCustom] = useState("");
  const [pick, setPick] = useState<Disposition | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [ai, setAi] = useState<TriageOutcome | null>(null);
  const [aiQ, setAiQ] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const narrative = sel ? sel.narrative : custom.trim();
  const isCustom = !sel;

  function choose(c: TrainingCase | null) { setSel(c); setPick(null); setRevealed(false); setAi(null); setAiQ(null); setLog([]); }
  function reset() { choose(TRAINING_CASES[0]); setCustom(""); }

  async function submit() {
    if (!pick || !narrative || busy) return;
    setBusy(true); setRevealed(true); setAi(null); setAiQ(null); setLog([]);
    const ac = new AbortController(); abort.current = ac;
    try {
      await runAiAssessment(narrative, (e) => {
        if (e.type === "reasoning") setLog((l) => [...l, `🧠 ${e.text.slice(0, 160)}`]);
        else if (e.type === "tool_call") setLog((l) => [...l, `🔧 ${e.name}`]);
        else if (e.type === "critique") { if (e.verdict && e.verdict.agree === false) setLog((l) => [...l, `🔍 safety review: ${e.verdict.rationale || "escalate"}`]); }
        else if (e.type === "consult") setLog((l) => [...l, `📞 peer: ${e.consult.answer || ""}`]);
        else if (e.type === "conclusion") setAi(e.outcome);
        else if (e.type === "question") setAiQ(e.text);
      }, ac.signal);
    } finally { setBusy(false); }
  }

  const g: Grade | null = pick && sel ? grade(pick, sel.expected) : null;
  const gColor = g ? (g.verdict === "correct" ? "var(--green)" : g.verdict === "under" ? "var(--red)" : "var(--amber)") : "var(--amber)";

  return (
    <>
      <div className="eyebrow">Training <span className="badge">pharmacist sandbox</span></div>
      <h1>Practice on simulated cases — safely</h1>
      <p className="lead">A teaching mode that reuses the real triage agent and its <strong>independent safety
        review</strong> as an answer key. Read a case, commit to a disposition, then see how you did against the
        clinician-authored answer and the AI's assessment. Simulated only — nothing touches the patient record,
        the knowledge base, or the safety signals.</p>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <strong>Case:</strong>
          {TRAINING_CASES.map((c) => (
            <button key={c.id} className={`btn ghost${sel?.id === c.id ? " active" : ""}`} onClick={() => choose(c)} disabled={busy}>{c.title}</button>
          ))}
          <button className={`btn ghost${isCustom ? " active" : ""}`} onClick={() => choose(null)} disabled={busy}>✍️ Write your own…</button>
        </div>
        {isCustom && (
          <textarea value={custom} onChange={(e) => { setCustom(e.target.value); setRevealed(false); setAi(null); }} disabled={busy}
            placeholder="Describe a patient case in your own words (prompt-to-scenario)…" style={{ width: "100%", minHeight: 70, marginTop: 8 }} />
        )}
        {!isCustom && sel && <p style={{ marginTop: 10 }}>{sel.narrative}</p>}
      </div>

      <div className="card">
        <strong>Your call — what's the safe disposition?</strong>
        <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
          {DISPOSITIONS.map((d) => (
            <button key={d} className={`btn ghost${pick === d ? " active" : ""}`} onClick={() => { setPick(d); setRevealed(false); }} disabled={busy}>
              <span className={`pill ${bandOf(d)}`} style={{ marginRight: 6 }}>{bandOf(d)}</span>{d}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={submit} disabled={!pick || !narrative || busy}>{busy ? "assessing…" : "Submit & reveal"}</button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={reset} disabled={busy}>↻ Reset</button>
        </div>
      </div>

      {revealed && (
        <>
          {g && (
            <div className="card" style={{ borderLeft: `3px solid ${gColor}` }}>
              <strong>{g.verdict === "correct" ? "✓" : g.verdict === "under" ? "⚠️" : "↑"} {g.label}</strong>
              <p className="note" style={{ margin: "4px 0 0" }}>
                You chose <span className={`pill ${bandOf(pick!)}`}>{pick}</span>; the authored answer is
                <span className={`pill ${bandOf(sel!.expected)}`} style={{ marginLeft: 6 }}>{sel!.expected}</span>.
                {!g.safe && " Under-triage is the error that misses emergencies."}
              </p>
            </div>
          )}
          {sel && (
            <div className="card" style={{ borderLeft: "3px solid var(--green)" }}>
              <strong>📖 Teaching point</strong>
              <p style={{ margin: "4px 0 0" }}>{sel.teaching}</p>
              <p className="note" style={{ marginTop: 6 }}><strong>Red flags:</strong> {sel.redFlags}</p>
            </div>
          )}
          <div className="card">
            <strong>🤖 The AI's independent assessment{isCustom ? " (no authored key — AI only, not ground truth)" : " (second opinion)"}</strong>
            {!ai && !aiQ && <p className="note" style={{ marginTop: 6 }}>{busy ? "running the triage agent + safety review…" : "—"}</p>}
            {aiQ && !ai && <p style={{ marginTop: 6 }}>The agent wanted more information: <em>{aiQ}</em></p>}
            {ai && (
              <div style={{ marginTop: 6 }}>
                <span className={`pill ${pillFor(ai.decision)}`}>{ai.decision}</span>
                <span className="note" style={{ marginLeft: 8 }}>severity {ai.severity}/10 · {ai.condition}{ai.icd ? ` · ${ai.icd}` : ""}</span>
                {ai.supervised?.escalated && (
                  <p className="note" style={{ marginTop: 6, color: "var(--red)" }}>🔍 Safety review escalated this from {ai.supervised.from}{ai.supervised.rationale ? ` — ${ai.supervised.rationale}` : ""}.</p>
                )}
                {ai.supervised && !ai.supervised.escalated && <p className="note" style={{ marginTop: 6 }}>🔍 Safety review agreed with this assessment.</p>}
                {ai.consult?.answer && <p className="note" style={{ marginTop: 4 }}>📞 Peer second opinion: {ai.consult.answer}</p>}
              </div>
            )}
            {!!log.length && (
              <ol className="audit-timeline" style={{ marginTop: 8 }}>
                {log.map((t, i) => <li key={i} className="audit-ev"><div className="audit-ev-sum">{t}</div></li>)}
              </ol>
            )}
          </div>
        </>
      )}
    </>
  );
}
