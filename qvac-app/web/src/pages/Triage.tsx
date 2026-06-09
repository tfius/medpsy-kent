import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { chatStream, type Msg } from "../lib/openai";
import { seed, isConclusion, parseTriage, questionText, CONCLUDE_NUDGE, type Triage as T } from "../lib/triage";
import { speak, stopSpeaking, listenLocal, sttSupported, fetchVoices, getVoice, setVoice, type Voice, type ListenControl } from "../lib/speech";
import { useEncounter } from "../store";

type Turn = { who: "bot" | "me"; text: string; reason?: string };
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
  const [streamReason, setStreamReason] = useState(""); // live reasoning (collapsible)
  const [streamAnswer, setStreamAnswer] = useState(""); // live answer
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const stopRef = useRef<null | ListenControl>(null);
  const [result, setResult] = useState<T | null>(enc.outcome);
  const [err, setErr] = useState("");
  const [autoSpeak, setAutoSpeak] = useState<boolean>(() => {
    try { return localStorage.getItem("medpsy.autoSpeak") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("medpsy.autoSpeak", autoSpeak ? "1" : "0"); } catch { /* ignore */ }
  }, [autoSpeak]);

  // Hands-free: once you answer by voice we keep the mic on (auto-arm after each
  // spoken question), for a natural back-and-forth. Typing or tapping the mic off
  // exits it. Refs mirror state so the async "arm after speaking" check is fresh.
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  const listeningRef = useRef(false);
  const resultRef = useRef<T | null>(result);
  useEffect(() => { handsFreeRef.current = handsFree; }, [handsFree]);
  useEffect(() => { listeningRef.current = listening; }, [listening]);
  useEffect(() => { resultRef.current = result; }, [result]);

  function startListening(onText: (t: string) => void) {
    if (listeningRef.current) return;
    stopSpeaking(); // don't let a spoken question feed back into the mic
    setErr(""); setHandsFree(true);
    stopRef.current = listenLocal(
      (t) => { setListening(false); setTranscribing(false); if (t) onText(t); },
      (e) => { setErr(e); setListening(false); setTranscribing(false); },
      (phase) => { setListening(phase === "recording"); setTranscribing(phase === "transcribing"); },
    );
  }
  function exitHandsFree() {
    setHandsFree(false);
    if (listeningRef.current) { stopRef.current?.cancel(); setListening(false); }
  }
  function toggleMic(onText: (t: string) => void) {
    if (listening) { exitHandsFree(); return; } // tap again = stop & leave hands-free
    startListening(onText);
  }
  // Arm the mic for the next answer when in hands-free mode (after the question
  // is spoken, or right away if auto-speak is off).
  function armForAnswer() {
    if (handsFreeRef.current && !listeningRef.current && !resultRef.current && sttSupported())
      startListening((t) => answer(t));
  }
  const Mic = ({ onText, disabled }: { onText: (t: string) => void; disabled?: boolean }) =>
    sttSupported() ? (
      <button type="button" className={`btn ghost mic${listening ? " listening" : ""}`}
        disabled={disabled || transcribing}
        title="Speak (on-device)" onClick={() => toggleMic(onText)}>
        {listening ? "● Listening…" : transcribing ? "… transcribing" : "🎤"}</button>
    ) : null;

  async function runTurn(history: Msg[], force = false) {
    setBusy(true);
    setErr("");
    setStreamReason(""); setStreamAnswer("");
    const send: Msg[] = force ? [...history, { role: "user", content: CONCLUDE_NUDGE }] : history;
    let lastReason = "";
    const onP = (p: { reasoning: string; answer: string }) => { lastReason = p.reasoning; setStreamReason(p.reasoning); setStreamAnswer(p.answer); };
    try {
      let reply = await chatStream(send, onP);
      if (!reply && !force) {
        // empty (reasoning consumed the budget) → retry once, asking to conclude
        reply = await chatStream([...history, { role: "user", content: CONCLUDE_NUDGE }], onP);
      }
      setStreamReason(""); setStreamAnswer("");
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
        setTurns((x) => [...x, { who: "bot", text: q, reason: lastReason }]);
        setAsked((n) => n + 1);
        // Read the question aloud, then (hands-free) auto-arm the mic for the answer.
        if (autoSpeak) speak(q).then(armForAnswer);
        else setTimeout(armForAnswer, 0);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStreamReason(""); setStreamAnswer("");
    }
  }

  async function begin(text: string = complaint) {
    const c = text.trim();
    if (!c) return;
    setComplaint(c);
    setSituation({ complaint: c });
    setStarted(true);
    setTurns([{ who: "me", text: c }]);
    await runTurn(seed(c, enc.situation.intake));
  }

  async function answer(text: string = input) {
    const a = text.trim();
    if (!a || busy) return;
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
      <p className="lead">A guided, multi-step assessment — type or tap 🎤 to speak. medpsy reasons before each reply, so a turn can take a few seconds.</p>

      <div className="voice-controls">
        <VoicePicker />
        <label className="toggle" title="Read each triage question aloud as it arrives">
          <input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} />
          🔊 Auto-speak questions
        </label>
      </div>

      {!started ? (
        <div className="card">
          <label htmlFor="c">What's bringing you in today?</label>
          <textarea id="c" value={complaint} onChange={(e) => { setComplaint(e.target.value); setHandsFree(false); }}
            placeholder="Type or tap 🎤 to speak your main symptom…" />
          {(listening || transcribing) && <div className="listening-bar">{listening ? "🔴 Listening… speak, then pause" : "⏳ Transcribing on-device…"}</div>}
          <div className="row">
            <Mic onText={(t) => { setComplaint(t); begin(t); }} />
            <button className="btn" onClick={() => begin()} disabled={!complaint.trim()}>Start triage</button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="chat">
            {turns.map((t, i) => t.who === "bot" ? (
              <div key={i}>
                {t.reason && (
                  <details className="thinking">
                    <summary>🧠 reasoning</summary>
                    <div className="think-body">{t.reason}</div>
                  </details>
                )}
                <div className="bubble bot">
                  {t.text}
                  <button className="speak" title="Read aloud" onClick={() => speak(t.text)}>🔊</button>
                </div>
              </div>
            ) : (
              <div key={i} className="bubble me">{t.text}</div>
            ))}
            {busy && (
              <>
                {streamReason && (
                  <details className="thinking" open>
                    <summary>🧠 thinking…</summary>
                    <div className="think-body">{streamReason}<span className="cursor">▋</span></div>
                  </details>
                )}
                {streamAnswer
                  ? <div className="bubble bot">{streamAnswer}<span className="cursor">▋</span></div>
                  : (!streamReason && <div className="typing">medpsy is thinking…</div>)}
              </>
            )}
          </div>

          {!result && (
            <>
              {(listening || transcribing) && <div className="listening-bar">{listening ? "🔴 Listening… speak, then pause" : "⏳ Transcribing on-device…"}</div>}
              <div className="row" style={{ marginTop: 4 }}>
                <input value={input}
                  placeholder={handsFree ? "Listening after each question — or type to take over…" : "Type or tap 🎤 to speak your answer…"}
                  onChange={(e) => { setInput(e.target.value); exitHandsFree(); }}
                  onKeyDown={(e) => e.key === "Enter" && answer()} disabled={busy} />
                <Mic onText={(t) => answer(t)} disabled={busy} />
                <button className="btn" onClick={() => answer()} disabled={busy || !input.trim()}>Send</button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn ghost" onClick={() => { exitHandsFree(); runTurn(msgs, true); }} disabled={busy || msgs.length === 0}>
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

// On-device TTS voice selector (Kokoro). Hidden if the speech server offers no
// voices (e.g. not running). The chosen voice is persisted and used by `speak`.
function VoicePicker() {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [sel, setSel] = useState(getVoice());

  useEffect(() => {
    let cancelled = false;
    fetchVoices().then((vs) => {
      if (cancelled) return;
      setVoices(vs);
      if (vs.length && !vs.some((v) => v.id === sel)) {
        const def = vs.find((v) => v.id === "af_heart") || vs[0];
        setSel(def.id); setVoice(def.id);
      }
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!voices.length) return null;
  const label = (v: Voice) =>
    `${v.name || v.id} — ${v.gender || "?"}, ${v.language || "?"}${v.grade ? ` (${v.grade})` : ""}`;

  return (
    <div className="voice-picker">
      <label htmlFor="voice">🔊 Voice</label>
      <select id="voice" value={sel} onChange={(e) => { setSel(e.target.value); setVoice(e.target.value); }}>
        {voices.map((v) => <option key={v.id} value={v.id}>{label(v)}</option>)}
      </select>
      <button type="button" className="btn ghost" title="Preview voice"
        onClick={() => speak("Hello, this is medpsy. How can I help you today?", sel)}>▶ Preview</button>
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
