// Triage Preceptor — clinical-education page. Three workflows: INTERVIEW (question a simulated
// patient, then decide — trains the real skill), QUICK (assess a full vignette), and BRING A CASE
// (a real/hypothetical case → the preceptor's grounded second opinion). The "preceptor" is the
// real safety-review gate. Everything runs in training mode — nothing touches the record.
import { useEffect, useRef, useState } from "react";
import { TRAINING_CASES, grade, bandOf, screeningCoverage, askPatient, runAiAssessment, type TrainingCase, type Disposition, type Grade } from "../lib/preceptor";
import type { ATriageEvent, TriageOutcome } from "../lib/atriage";

type Mode = "interview" | "quick" | "bring";
type QA = { role: "user" | "assistant"; content: string };
const DISPOSITIONS: Disposition[] = ["EMERGENCY", "URGENT", "PHARMACIST-LED", "ROUTINE"];
const pillFor = (d?: string) => d === "EMERGENCY" ? "RED" : d === "URGENT" || d === "INSUFFICIENT-DATA" ? "AMBER" : "GREEN";

export default function Preceptor() {
  const [mode, setMode] = useState<Mode>("interview");
  const [sel, setSel] = useState<TrainingCase>(TRAINING_CASES[0]);
  const [qa, setQa] = useState<QA[]>([]);          // interview exchanges (user=pharmacist, assistant=patient)
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState(false);
  const [pick, setPick] = useState<Disposition | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);          // AI assessment running
  const [ai, setAi] = useState<TriageOutcome | null>(null);
  const [aiQ, setAiQ] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [bring, setBring] = useState("");
  const [score, setScore] = useState({ done: 0, correct: 0, over: 0, under: 0 });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  function resetCase(c = sel) { abort.current?.abort(); setSel(c); setQa([]); setQ(""); setPick(null); setRevealed(false); setAi(null); setAiQ(null); setLog([]); }
  function switchMode(m: Mode) { setMode(m); resetCase(); }

  const onAiEvent = (e: ATriageEvent) => {
    if (e.type === "reasoning") setLog((l) => [...l, `🧠 ${e.text.slice(0, 140)}`]);
    else if (e.type === "critique") { if (e.verdict && e.verdict.agree === false) setLog((l) => [...l, `🔍 ${e.verdict.rationale || "escalate"}`]); }
    else if (e.type === "consult") setLog((l) => [...l, `📞 ${e.consult.answer || ""}`]);
    else if (e.type === "conclusion") setAi(e.outcome);
    else if (e.type === "question") setAiQ(e.text);
  };

  async function ask() {
    const text = q.trim(); if (!text || asking) return;
    setQ(""); setAsking(true);
    const sent = [...qa];
    setQa((c) => [...c, { role: "user", content: text }]);
    try { const reply = await askPatient(sel.narrative, sent, text); setQa((c) => [...c, { role: "assistant", content: reply }]); }
    finally { setAsking(false); }
  }

  async function decide(p: Disposition) {
    if (busy) return;
    setPick(p); setRevealed(true); setBusy(true); setAi(null); setAiQ(null); setLog([]);
    const g = grade(p, sel.expected);
    setScore((s) => ({ done: s.done + 1, correct: s.correct + (g.verdict === "correct" ? 1 : 0), over: s.over + (g.verdict === "over" ? 1 : 0), under: s.under + (g.verdict === "under" ? 1 : 0) }));
    const ac = new AbortController(); abort.current = ac;
    try { await runAiAssessment(sel.narrative, onAiEvent, ac.signal); } finally { setBusy(false); }
  }

  async function getRead() {
    const text = bring.trim(); if (!text || busy) return;
    setRevealed(true); setBusy(true); setAi(null); setAiQ(null); setLog([]);
    const ac = new AbortController(); abort.current = ac;
    try { await runAiAssessment(text, onAiEvent, ac.signal); } finally { setBusy(false); }
  }

  const asked = qa.filter((t) => t.role === "user").map((t) => t.content);
  const coverage = screeningCoverage(asked, sel.mustScreen);
  const probed = coverage.filter((c) => c.asked).length;
  const g: Grade | null = pick ? grade(pick, sel.expected) : null;
  const gColor = g ? (g.verdict === "correct" ? "var(--green)" : g.verdict === "under" ? "var(--red)" : "var(--amber)") : "var(--amber)";

  return (
    <>
      <div className="eyebrow">Training <span className="badge">triage preceptor</span></div>
      <h1>Triage Preceptor</h1>
      <p className="lead">Practise like you would under a senior pharmacist. <strong>Interview</strong> a simulated
        patient and decide — the preceptor (our independent safety review) grades whether you screened the red
        flags and made the safe call. Simulated only: nothing touches the patient record, knowledge base, or
        safety signals.</p>

      {/* session scorecard — drive under-triage to zero */}
      {score.done > 0 && (
        <div className="card" style={{ display: "flex", gap: 18, alignItems: "baseline", flexWrap: "wrap" }}>
          <strong>This session</strong>
          <span><strong style={{ fontSize: 20 }}>{score.done}</strong> <span className="note">cases</span></span>
          <span style={{ color: "var(--green)" }}>✓ {score.correct} correct</span>
          <span style={{ color: "var(--amber)" }}>↑ {score.over} over-cautious</span>
          <span style={{ color: score.under ? "var(--red)" : "var(--green)", fontWeight: 600 }}>⚠ {score.under} under-triaged</span>
          <span className="note">goal: zero under-triage</span>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <button className={`btn ghost${mode === "interview" ? " active" : ""}`} onClick={() => switchMode("interview")} disabled={asking || busy}>🩺 Interview a patient</button>
          <button className={`btn ghost${mode === "quick" ? " active" : ""}`} onClick={() => switchMode("quick")} disabled={asking || busy}>⚡ Quick assess</button>
          <button className={`btn ghost${mode === "bring" ? " active" : ""}`} onClick={() => switchMode("bring")} disabled={asking || busy}>📋 Bring a case</button>
        </div>

        {mode !== "bring" && (
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            <strong style={{ alignSelf: "center" }}>Case:</strong>
            {TRAINING_CASES.map((c) => <button key={c.id} className={`btn ghost${sel.id === c.id ? " active" : ""}`} onClick={() => resetCase(c)} disabled={asking || busy}>{c.title}</button>)}
          </div>
        )}
      </div>

      {/* INTERVIEW */}
      {mode === "interview" && (
        <div className="card">
          <p className="note">Ask the patient questions to uncover the picture, then decide. <strong>{probed}</strong>/{sel.mustScreen.length} key areas probed so far.</p>
          <div className="chat" style={{ display: "flex", flexDirection: "column", gap: 6, margin: "8px 0" }}>
            <div className="bubble" style={{ alignSelf: "flex-start", background: "var(--card2,#eef)", padding: "6px 10px", borderRadius: 8 }}>🧑 {sel.opening}</div>
            {qa.map((t, i) => (
              <div key={i} className="bubble" style={{ alignSelf: t.role === "user" ? "flex-end" : "flex-start", background: t.role === "user" ? "var(--accent,#2563eb)" : "var(--card2,#eef)", color: t.role === "user" ? "#fff" : "inherit", padding: "6px 10px", borderRadius: 8, maxWidth: "85%" }}>
                {t.role === "user" ? "🧑‍⚕️ " : "🧑 "}{t.content}
              </div>
            ))}
            {asking && <div className="note" style={{ alignSelf: "flex-start" }}>patient is answering…</div>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") ask(); }} disabled={asking || busy} placeholder="Ask the patient a question…" style={{ flex: 1 }} />
            <button className="btn ghost" onClick={ask} disabled={asking || busy || !q.trim()}>Ask</button>
          </div>
        </div>
      )}

      {/* QUICK */}
      {mode === "quick" && <div className="card"><p style={{ margin: 0 }}>{sel.narrative}</p></div>}

      {/* decide (interview + quick) */}
      {mode !== "bring" && (
        <div className="card">
          <strong>Your call — what's the safe disposition?</strong>
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
            {DISPOSITIONS.map((d) => (
              <button key={d} className={`btn ghost${pick === d ? " active" : ""}`} onClick={() => decide(d)} disabled={busy}>
                <span className={`pill ${bandOf(d)}`} style={{ marginRight: 6 }}>{bandOf(d)}</span>{d}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <button className="btn ghost" onClick={() => resetCase()} disabled={asking || busy}>↻ New case</button>
          </div>
        </div>
      )}

      {/* BRING A CASE */}
      {mode === "bring" && (
        <div className="card">
          <strong>Bring a case for a second opinion</strong>
          <p className="note" style={{ margin: "4px 0" }}>Describe a real or hypothetical case in your own words. The preceptor gives a grounded, safety-reviewed read — a second opinion for reflection, not a graded answer key.</p>
          <textarea value={bring} onChange={(e) => setBring(e.target.value)} disabled={busy} placeholder="e.g. 67-year-old, sudden severe one-sided headache with vomiting, came in for paracetamol…" style={{ width: "100%", minHeight: 80 }} />
          <div className="row" style={{ marginTop: 8 }}><button className="btn" onClick={getRead} disabled={busy || !bring.trim()}>{busy ? "consulting…" : "Get the preceptor's read"}</button></div>
        </div>
      )}

      {/* REVEAL */}
      {revealed && (
        <>
          {g && (
            <div className="card" style={{ borderLeft: `3px solid ${gColor}` }}>
              <strong>{g.verdict === "correct" ? "✓" : g.verdict === "under" ? "⚠️" : "↑"} {g.label}</strong>
              <p className="note" style={{ margin: "4px 0 0" }}>
                You chose <span className={`pill ${bandOf(pick!)}`}>{pick}</span>; the authored answer is
                <span className={`pill ${bandOf(sel.expected)}`} style={{ marginLeft: 6 }}>{sel.expected}</span>.
                {!g.safe && " Under-triage is the error that misses emergencies."}
              </p>
            </div>
          )}
          {mode === "interview" && g && (
            <div className="card">
              <strong>🔎 Red-flag screening</strong>
              <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {coverage.map((c) => <span key={c.label} className={`pill ${c.asked ? "GREEN" : "RED"}`}>{c.asked ? "✓" : "✗"} {c.label}</span>)}
              </div>
              {coverage.some((c) => !c.asked) && <p className="note" style={{ marginTop: 6 }}>You didn't probe: {coverage.filter((c) => !c.asked).map((c) => c.label).join(", ")} — these are what this case hinges on.</p>}
            </div>
          )}
          {g && (
            <div className="card" style={{ borderLeft: "3px solid var(--green)" }}>
              <strong>📖 Teaching point</strong>
              <p style={{ margin: "4px 0 0" }}>{sel.teaching}</p>
              <p className="note" style={{ marginTop: 6 }}><strong>Red flags:</strong> {sel.redFlags}</p>
            </div>
          )}
          <div className="card">
            <strong>🤖 The preceptor's own read{mode === "bring" ? " (grounded second opinion — not ground truth)" : g ? " (independent assessment)" : ""}</strong>
            {!ai && !aiQ && <p className="note" style={{ marginTop: 6 }}>{busy ? "running the triage agent + safety review…" : "—"}</p>}
            {aiQ && !ai && <p style={{ marginTop: 6 }}>The agent wanted more information: <em>{aiQ}</em></p>}
            {ai && (
              <div style={{ marginTop: 6 }}>
                <span className={`pill ${pillFor(ai.decision)}`}>{ai.decision}</span>
                <span className="note" style={{ marginLeft: 8 }}>severity {ai.severity}/10 · {ai.condition}{ai.icd ? ` · ${ai.icd}` : ""}</span>
                {ai.supervised?.escalated && <p className="note" style={{ marginTop: 6, color: "var(--red)" }}>🔍 Safety review escalated this from {ai.supervised.from}{ai.supervised.rationale ? ` — ${ai.supervised.rationale}` : ""}.</p>}
                {ai.supervised && !ai.supervised.escalated && <p className="note" style={{ marginTop: 6 }}>🔍 Safety review agreed with this assessment.</p>}
                {ai.consult?.answer && <p className="note" style={{ marginTop: 4 }}>📞 Peer second opinion: {ai.consult.answer}</p>}
              </div>
            )}
            {!!log.length && <ol className="audit-timeline" style={{ marginTop: 8 }}>{log.map((t, i) => <li key={i} className="audit-ev"><div className="audit-ev-sum">{t}</div></li>)}</ol>}
          </div>
        </>
      )}
    </>
  );
}
