import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { chatStream, type Msg } from "../lib/openai";
import { seed, isConclusion, parseTriage, questionText, CONCLUDE_NUDGE, type Triage as T } from "../lib/triage";
import { searchKnowledge, docLabel, type KnowledgePassage } from "../lib/knowledge";
import { speak, stopSpeaking, listenLocal, sttSupported, type ListenControl } from "../lib/speech";
import { toEnglish, fromEnglish, localizeTriage } from "../lib/translate";
import { SpeakButton } from "../lib/voice";
import { TriageResult, useHelp } from "../lib/ui";
import { useEncounter } from "../store";
import { useT, usePrefs } from "../lib/prefs";
import { audit } from "../lib/audit";

type Turn = { who: "bot" | "me"; text: string; reason?: string };
const CAP = 6; // max questions before we force a conclusion

export default function Triage() {
  const { enc, setSituation, set } = useEncounter();
  const nav = useNavigate();
  const { openHelp } = useHelp();
  const T = useT();
  const { autoSpeak, lang } = usePrefs();
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
  const [resultReason, setResultReason] = useState(""); // reasoning behind the final verdict
  const [know, setKnow] = useState<KnowledgePassage[]>([]); // pharmacist reference passages
  const knowReq = useRef(0); // staleness guard: only the latest fetch may set `know`
  const [err, setErr] = useState("");

  // Pull matching protocols/monographs for the (English, canonical) conclusion. Guarded
  // so a slow response from a prior conclusion can't repopulate the panel after a restart.
  function fetchKnow(t: T) {
    const q = [t.condition, t.redFlags].filter((s) => s && !/^none/i.test(s)).join(". ");
    const req = ++knowReq.current;
    searchKnowledge(q).then((r) => { if (req === knowReq.current) setKnow(r); });
  }

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
  // A stored outcome (revisiting the step) is English — translate it for the patient view once.
  useEffect(() => {
    let live = true;
    if (enc.outcome && lang !== "en") localizeTriage(enc.outcome, lang).then((s) => { if (live) setResult(s); });
    if (enc.outcome) fetchKnow(enc.outcome); // revisiting the step — repopulate the reference panel
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // bargeIn: arm the mic while the question is still being spoken (don't cut the TTS
  // up front) — onSpeechStart stops it only once the user actually starts talking.
  // Otherwise (manual tap) cut any speech immediately and record.
  function startListening(onText: (t: string) => void, { bargeIn = false } = {}) {
    if (listeningRef.current) return;
    if (!bargeIn) stopSpeaking();
    setErr(""); setHandsFree(true);
    stopRef.current = listenLocal(
      (t) => { setListening(false); setTranscribing(false); if (t) onText(t); },
      (e) => { setErr(e); setListening(false); setTranscribing(false); },
      (phase) => { setListening(phase === "recording"); setTranscribing(phase === "transcribing"); },
      () => stopSpeaking(), // user started speaking -> stop the question (barge-in)
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
      startListening((t) => answer(t), { bargeIn: true });
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
        setErr(T("tri.noText"));
        return;
      }
      if (isConclusion(reply)) {
        setMsgs([...send, { role: "assistant", content: reply }]);
        const t = parseTriage(reply); // English — stays canonical for SBAR / ICD / clinician view
        setResultReason(lastReason); // keep the reasoning that produced the verdict
        set({ outcome: t });
        fetchKnow(t); // pharmacist reference passages (on-device knowledge base)
        setResult(await localizeTriage(t, lang)); // patient-facing copy in their language
      } else {
        const q = questionText(reply); // strip any leaked reasoning → just the question
        setMsgs([...send, { role: "assistant", content: q }]); // medpsy history stays English
        const qLocal = await fromEnglish(q, lang); // what the patient reads + hears
        setTurns((x) => [...x, { who: "bot", text: qLocal, reason: lastReason }]);
        audit.botTurn(qLocal, lastReason); // English raw is captured server-side as model.io
        setAsked((n) => n + 1);
        // Read the question aloud AND (hands-free) arm the mic now — you can answer
        // over the question (barge-in stops it) or wait; the mic is already listening.
        if (autoSpeak) speak(qLocal);
        armForAnswer();
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
    setSituation({ complaint: c }); // store the patient's own words (display + record)
    setStarted(true);
    setTurns([{ who: "me", text: c }]);
    audit.userTurn(c);
    // medpsy reasons only in English → translate the complaint + intake before seeding.
    setBusy(true);
    const [cEN, intakeEN] = await Promise.all([toEnglish(c, lang), toEnglish(enc.situation.intake, lang)]);
    await runTurn(seed(cEN, intakeEN));
  }

  async function answer(text: string = input) {
    const a = text.trim();
    if (!a || busy) return;
    setInput("");
    setTurns((x) => [...x, { who: "me", text: a }]); // show the patient's own words
    audit.userTurn(a);
    setBusy(true);
    const aEN = await toEnglish(a, lang); // … but send English to medpsy
    const next: Msg[] = [...msgs, { role: "user", content: aEN }];
    setMsgs(next);
    await runTurn(next, asked + 1 >= CAP); // force conclusion once enough has been asked
  }

  function restart() {
    setStarted(false); setMsgs([]); setTurns([]); setAsked(0);
    knowReq.current++; // invalidate any in-flight knowledge fetch from the previous encounter
    setInput(""); setResult(null); setResultReason(""); setKnow([]); setErr(""); set({ outcome: null });
  }

  return (
    <>
      <div className="eyebrow">{T("tri.eyebrow")}</div>
      <h1>{T("tri.title")}</h1>
      <p className="lead">{T("tri.lead")}</p>

      {!started ? (
        <div className="card">
          <label htmlFor="c">{T("tri.complaintQ")}</label>
          <textarea id="c" value={complaint} onChange={(e) => { setComplaint(e.target.value); setHandsFree(false); }}
            placeholder={T("tri.mainPh")} />
          {(listening || transcribing) && <div className="listening-bar">{listening ? "🔴 Listening… speak, then pause" : "⏳ Transcribing on-device…"}</div>}
          <div className="row">
            <Mic onText={(t) => { setComplaint(t); begin(t); }} />
            <button className="btn" onClick={() => begin()} disabled={!complaint.trim()}>{T("tri.start")}</button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="chat">
            {turns.map((t, i) => t.who === "bot" ? (
              <div key={i}>
                {t.reason && (
                  <details className="thinking">
                    <summary>🧠 {T("tri.reasoning")}</summary>
                    <div className="think-body">{t.reason}</div>
                  </details>
                )}
                <div className="bubble bot">
                  {t.text}
                  <SpeakButton text={t.text} compact />
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
                {/* The live token stream is English; show it as-is for English patients,
                    otherwise just a "thinking" indicator (the translated bubble lands when done). */}
                {streamAnswer && lang === "en"
                  ? <div className="bubble bot">{streamAnswer}<span className="cursor">▋</span></div>
                  : (!streamReason && <div className="typing">{T("tri.thinking")}</div>)}
              </>
            )}
          </div>

          {!result && (
            <>
              {(listening || transcribing) && <div className="listening-bar">{listening ? "🔴 Listening… speak, then pause" : "⏳ Transcribing on-device…"}</div>}
              <div className="row" style={{ marginTop: 4 }}>
                <input value={input}
                  placeholder={handsFree ? T("tri.handsfreePh") : T("tri.answerPh")}
                  onChange={(e) => { setInput(e.target.value); exitHandsFree(); }}
                  onKeyDown={(e) => e.key === "Enter" && answer()} disabled={busy} />
                <Mic onText={(t) => answer(t)} disabled={busy} />
                <button className="btn" onClick={() => answer()} disabled={busy || !input.trim()}>{T("tri.send")}</button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn ghost" onClick={() => { exitHandsFree(); runTurn(msgs, true); }} disabled={busy || msgs.length === 0}>
                  {T("tri.conclude")}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {err && <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>⚠ {err}</div>}

      {result && (
        <>
          {resultReason && (
            <details className="thinking" style={{ marginBottom: 10 }}>
              <summary>🧠 {T("tri.howReached")}</summary>
              <div className="think-body">{resultReason}</div>
            </details>
          )}
          <TriageResult t={result} view="patient"
            onNext={() => nav(result.band === "GREEN" ? "/route" : "/history")}
            onEmergency={() => openHelp(true)} />
          {/* Pharmacist reference — retrieved from the on-device knowledge base (local
              protocols + interaction monographs). Clinician-facing: stays English. */}
          {know.length > 0 && (
            <details className="card" style={{ marginTop: 10 }}>
              <summary>📚 Pharmacist reference — local protocols &amp; interactions ({know.length})
                {" "}<span className="note">on-device retrieval; reference only, not patient advice</span></summary>
              {know.map((k, i) => (
                <details key={i} style={{ marginTop: 8 }} open={i === 0}>
                  <summary><b>{docLabel(k.doc)}</b> <span className="note">match {k.score}</span></summary>
                  <div className="note" style={{ whiteSpace: "pre-wrap", fontSize: 13, marginTop: 4 }}>{k.content}</div>
                </details>
              ))}
            </details>
          )}
          <div className="row"><button className="btn ghost" onClick={restart}>↻ {T("tri.restart")}</button></div>
        </>
      )}
    </>
  );
}
