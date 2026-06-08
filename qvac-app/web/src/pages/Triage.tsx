import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { chat, type Msg } from "../lib/openai";
import { seed, isConclusion, parseTriage, questionText, CONCLUDE_NUDGE, type Triage as T } from "../lib/triage";
import { speak, listenOnce, sttSupported } from "../lib/speech";
import { useEncounter } from "../store";

type Turn = { who: "bot" | "me"; text: string };
const CAP = 6; // max questions before we force a conclusion

export default function Triage() {
  const { enc, setSituation, set } = useEncounter();
  const nav = useNavigate();
  const [complaint, setComplaint] = useState(enc.situation.complaint);
  const [started, setStarted] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asked, setAsked] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<T | null>(enc.outcome);
  const [err, setErr] = useState("");

  async function runTurn(history: Msg[], force = false) {
    setBusy(true);
    setErr("");
    const send: Msg[] = force ? [...history, { role: "user", content: CONCLUDE_NUDGE }] : history;
    try {
      let reply = await chat(send);
      if (!reply && !force) {
        // empty (reasoning consumed the budget) → retry once, asking to conclude
        reply = await chat([...history, { role: "user", content: CONCLUDE_NUDGE }]);
      }
      if (!reply) {
        setErr("The model returned no text — try again, or use “Conclude now”.");
        return;
      }
      if (isConclusion(reply)) {
        setMsgs([...send, { role: "assistant", content: reply }]);
        const t = parseTriage(reply);
        setResult(t);
        set({ outcome: t });
      } else {
        const q = questionText(reply); // strip any leaked reasoning → just the question
        setMsgs([...send, { role: "assistant", content: q }]);
        setTurns((x) => [...x, { who: "bot", text: q }]);
        setAsked((n) => n + 1);
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
    await runTurn(next, asked + 1 >= CAP); // force conclusion once enough has been asked
  }

  function restart() {
    setStarted(false); setMsgs([]); setTurns([]); setAsked(0);
    setInput(""); setResult(null); setErr(""); set({ outcome: null });
  }

  return (
    <>
      <div className="eyebrow">Step 5 · Triage</div>
      <h1>Triage interview</h1>
      <p className="lead">A guided, multi-step assessment — type your answers. medpsy reasons before each reply, so a turn can take a few seconds.</p>

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
            {turns.map((t, i) => t.who === "bot" ? (
              <div key={i} className="bubble bot">
                {t.text}
                <button className="speak" title="Read aloud" onClick={() => speak(t.text)}>🔊</button>
              </div>
            ) : (
              <div key={i} className="bubble me">{t.text}</div>
            ))}
            {busy && <div className="typing">medpsy is thinking…</div>}
          </div>

          {!result && (
            <>
              <div className="row" style={{ marginTop: 4 }}>
                <input value={input} placeholder="Type or speak your answer…"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && answer()} disabled={busy} />
                {sttSupported() && (
                  <button className="btn ghost" title="Speak your answer" disabled={busy}
                    onClick={() => listenOnce((t) => setInput(t), (e) => setErr(e))}>🎤</button>
                )}
                <button className="btn" onClick={answer} disabled={busy || !input.trim()}>Send</button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn ghost" onClick={() => runTurn(msgs, true)} disabled={busy || msgs.length === 0}>
                  Conclude now
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {err && <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>⚠ {err}</div>}

      {result && (
        <Result t={result} onNext={() => nav(result.band === "GREEN" ? "/route" : "/history")} onRestart={restart} />
      )}
    </>
  );
}

function Result({ t, onNext, onRestart }: { t: T; onNext: () => void; onRestart: () => void }) {
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
        <IcdField condition={t.condition} guess={t.icd} />
        <Field k="Routing" v={t.routing} />
        <Field k="Safety-net" v={t.safetyNet} />
        <div className="row">
          <button className="btn" onClick={onNext}>
            {band === "GREEN" ? "Continue → routing" : "Continue → fetch history"}
          </button>
          <button className="btn ghost" onClick={onRestart}>Restart</button>
        </div>
        <p className="note" style={{ marginTop: 10 }}>Decision-support only — a practitioner validates this outcome.</p>
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

// ICD-10 grounded on-device: look up the verified code for the named condition,
// replacing medpsy's (often wrong) guess.
function IcdField({ condition, guess }: { condition: string; guess: string }) {
  const [verified, setVerified] = useState<{ code: string; description: string } | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");

  useEffect(() => {
    if (!condition) { setState("err"); return; }
    let cancelled = false;
    fetch("/api/icd", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ condition }) })
      .then((r) => r.json())
      .then((d) => { if (cancelled) return; const top = d.results?.[0]; top ? (setVerified(top), setState("ok")) : setState("err"); })
      .catch(() => !cancelled && setState("err"));
    return () => { cancelled = true; };
  }, [condition]);

  const guessCode = (guess.match(/[A-TV-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?/) || [""])[0];
  const mismatch = verified && guessCode && guessCode.replace(".", "") !== verified.code.replace(".", "");

  return (
    <div className="field">
      <div className="k">ICD-10 — verified on-device</div>
      {state === "loading" && <div className="v note">grounding against the on-device ICD-10 index…</div>}
      {state === "err" && <div className="v">{guess || "—"} <span className="note">(lookup unavailable — start the ICD API: <code>npm run serve</code>)</span></div>}
      {state === "ok" && verified && (
        <div className="v">
          <span className="pill GREEN">✓ {verified.code}</span> {verified.description}
          {mismatch && <div className="note" style={{ marginTop: 4 }}>medpsy guessed <s>{guessCode}</s> — replaced with the verified code</div>}
        </div>
      )}
    </div>
  );
}
