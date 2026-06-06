import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { chat, type Msg } from "../lib/openai";
import { seed, isConclusion, parseTriage, type Triage as T } from "../lib/triage";
import { useEncounter } from "../store";

type Turn = { who: "bot" | "me"; text: string };

export default function Triage() {
  const { enc, setSituation, set } = useEncounter();
  const nav = useNavigate();
  const [complaint, setComplaint] = useState(enc.situation.complaint);
  const [started, setStarted] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<T | null>(enc.outcome);
  const [err, setErr] = useState("");

  async function runTurn(history: Msg[]) {
    setBusy(true); setErr("");
    try {
      const reply = await chat(history);
      if (isConclusion(reply)) {
        const t = parseTriage(reply);
        setResult(t); set({ outcome: t });
      } else {
        setTurns((x) => [...x, { who: "bot", text: reply }]);
        setMsgs([...history, { role: "assistant", content: reply }]);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function begin() {
    if (!complaint.trim()) return;
    setSituation({ complaint });
    setStarted(true);
    setTurns([{ who: "me", text: complaint }]);
    await runTurn(seed(complaint, enc.situation.intake));
  }

  async function answer() {
    if (!input.trim() || busy) return;
    const a = input.trim();
    setInput("");
    setTurns((x) => [...x, { who: "me", text: a }]);
    const next: Msg[] = [...msgs, { role: "user", content: a }];
    setMsgs(next);
    await runTurn(next);
  }

  return (
    <>
      <div className="eyebrow">Step 5 · Triage</div>
      <h1>Triage interview</h1>
      <p className="lead">A guided, multi-step assessment. Answer each question by typing (voice coming in intake).</p>

      {!started ? (
        <div className="card">
          <label htmlFor="c">What's bringing you in today?</label>
          <textarea id="c" value={complaint} onChange={(e) => setComplaint(e.target.value)}
            placeholder="Describe your main symptom in your own words…" />
          <div className="row">
            <button className="btn block" onClick={begin} disabled={!complaint.trim()}>Start triage</button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="chat">
            {turns.map((t, i) => (
              <div key={i} className={`bubble ${t.who}`}>{t.text}</div>
            ))}
            {busy && <div className="typing">medpsy is thinking…</div>}
          </div>

          {!result && (
            <div className="row" style={{ marginTop: 4 }}>
              <input value={input} placeholder="Type your answer…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && answer()} disabled={busy} />
              <button className="btn" onClick={answer} disabled={busy || !input.trim()}>Send</button>
            </div>
          )}
        </div>
      )}

      {err && <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>⚠ {err}</div>}

      {result && <Result t={result} onNext={() => nav(result.band === "GREEN" ? "/route" : "/history")} />}
    </>
  );
}

function Result({ t, onNext }: { t: T; onNext: () => void }) {
  const band = t.band || "AMBER";
  return (
    <div className="result" style={{ marginBottom: 18 }}>
      <div className={`banner ${band}`}>
        {t.decision || "TRIAGE"}
        <span className="sev">Severity {(t.severity.match(/\d+/) || ["?"])[0]}/10 · {band}</span>
      </div>
      <div className="body">
        <Field k="Red flags" v={t.redFlags || "none identified"} />
        <Field k="Working diagnosis" v={t.condition} />
        <Field k="ICD-10 (provisional — verified on-device next)" v={t.icd} />
        <Field k="Routing" v={t.routing} />
        <Field k="Safety-net" v={t.safetyNet} />
        <div className="row">
          <button className="btn block" onClick={onNext}>
            {band === "GREEN" ? "Continue → routing" : "Continue → fetch history"}
          </button>
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          Decision-support only — a practitioner validates this outcome.
        </p>
      </div>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="field">
      <div className="k">{k}</div>
      <div className="v">{v || "—"}</div>
    </div>
  );
}
