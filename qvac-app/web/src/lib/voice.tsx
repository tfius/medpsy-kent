// Reusable on-device voice widgets, shared across the kiosk stages. They reuse the
// same local STT (listenLocal -> /api/stt, Nemotron) and TTS (speak -> /api/tts,
// Kokoro) as the triage screen. Triage keeps its own hands-free mic; these are the
// simple press-to-dictate / read-aloud controls for single fields.
import { useEffect, useId, useRef, useState } from "react";
import { listenLocal, speak, stopSpeaking, sttSupported, getSpeakState, subscribeSpeak, fetchVoices, getVoice, setVoice, type ListenControl, type Voice } from "./speech";
import { useT, usePrefs, LANG_SUPPORT, VOICE_FOR_LANG } from "./prefs";

// Subscribe to the app-wide TTS playback state (idle/loading/speaking + owner id).
function useSpeakState() {
  const [s, setS] = useState(getSpeakState());
  useEffect(() => subscribeSpeak(() => setS(getSpeakState())), []);
  return s;
}

// Press-to-dictate: tap -> record -> on-device transcription -> onText(transcript).
// Renders nothing if the browser can't capture audio.
export function MicButton({ onText, disabled, title }:
  { onText: (t: string) => void; disabled?: boolean; title?: string }) {
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const [err, setErr] = useState("");
  const ctl = useRef<ListenControl | null>(null);
  if (!sttSupported()) return null;
  const toggle = () => {
    if (phase === "recording") { ctl.current?.cancel(); setPhase("idle"); return; }
    if (phase === "transcribing") return;
    stopSpeaking(); setErr(""); // don't let any read-aloud bleed into the mic
    ctl.current = listenLocal(
      (t) => { setPhase("idle"); if (t) onText(t); },
      (e) => { setPhase("idle"); setErr(e); },
      (p) => setPhase(p),
      () => stopSpeaking(), // barge-in: stop any read-aloud the instant the user speaks
    );
  };
  return (
    <>
      <button type="button" className={`btn ghost mic${phase === "recording" ? " listening" : ""}`}
        disabled={disabled || phase === "transcribing"} title={title || "Speak (on-device)"} onClick={toggle}>
        {phase === "recording" ? "● Listening… (tap to stop)" : phase === "transcribing" ? "… transcribing" : "🎤 Speak"}
      </button>
      {err && <span className="note mic-err" role="alert">{err}</span>}
    </>
  );
}

// A textarea with a built-in dictation button; spoken text is appended to the field.
export function VoiceTextarea({ value, onChange, id, placeholder, rows }:
  { value: string; onChange: (v: string) => void; id?: string; placeholder?: string; rows?: number }) {
  const ref = useRef(value);
  ref.current = value; // keep current for the async mic callback (no stale closure)
  return (
    <div className="voice-field">
      <textarea id={id} value={value} placeholder={placeholder} rows={rows}
        onChange={(e) => onChange(e.target.value)} />
      <MicButton onText={(t) => onChange(ref.current ? `${ref.current} ${t}` : t)} />
    </div>
  );
}

// Read-aloud button (Kokoro TTS, with fallback). Shows loading -> speaking, and a
// second press stops it. Only one read-aloud plays at a time app-wide, so this
// also reflects when another control is speaking (it just shows the idle label).
// `compact` renders the inline icon-only variant used inside chat bubbles.
export function SpeakButton({ text, label = "Read aloud", voice, compact = false }:
  { text: string; label?: string; voice?: string; compact?: boolean }) {
  const id = useId();
  const st = useSpeakState();
  const mine = st.id === id && st.status !== "idle";
  const loading = st.id === id && st.status === "loading";
  const onClick = () => (mine ? stopSpeaking() : speak(text, { id, voice }));
  if (compact) {
    return (
      <button type="button" className={`speak${mine ? " speaking" : ""}`} aria-pressed={mine}
        title={mine ? "Stop" : "Read aloud"} onClick={onClick}>
        {loading ? "⏳" : mine ? "⏹" : "🔊"}
      </button>
    );
  }
  return (
    <button type="button" className={`btn ghost speak-btn${mine ? " speaking" : ""}`} aria-pressed={mine}
      title={mine ? "Stop" : "Read aloud"} onClick={onClick}>
      {loading ? "⏳ Loading…" : mine ? "⏹ Stop" : `🔊 ${label}`}
    </button>
  );
}

// Language-aware TTS voice picker (welcome step). Shows Kokoro voices for the
// current UI language, falling back to English when that language has no voice.
export function VoicePicker() {
  const T = useT();
  const { lang } = usePrefs();
  const [voices, setVoices] = useState<Voice[]>([]);
  const [sel, setSel] = useState(getVoice());

  useEffect(() => { let c = false; fetchVoices().then((vs) => { if (!c) setVoices(vs); }); return () => { c = true; }; }, []);

  const prefixes = LANG_SUPPORT[lang].ttsPrefixes;
  const matching = prefixes.length ? voices.filter((v) => prefixes.some((p) => v.id.startsWith(p))) : [];
  const shown = matching.length ? matching : voices.filter((v) => v.id.startsWith("a") || v.id.startsWith("b"));

  // keep the selected voice within the shown set as the language changes
  useEffect(() => {
    if (!shown.length || shown.some((v) => v.id === sel)) return;
    const def = shown.find((v) => v.id === VOICE_FOR_LANG[lang]) || shown[0];
    setSel(def.id); setVoice(def.id);
  }); // runs each render; cheap and keeps sel valid

  if (!voices.length) return null;
  const optLabel = (v: Voice) => `${v.name || v.id} — ${v.gender || "?"}${v.grade ? ` (${v.grade})` : ""}`;
  const note = LANG_SUPPORT[lang].ttsNote;
  return (
    <div className="voice-picker">
      <label className="picker-label" htmlFor="voice">🔊 {T("voice")}{note && <span className="note"> · {note}</span>}</label>
      <div className="voice-picker-row">
        <select id="voice" value={sel} onChange={(e) => { setSel(e.target.value); setVoice(e.target.value); }}>
          {shown.map((v) => <option key={v.id} value={v.id}>{optLabel(v)}</option>)}
        </select>
        <SpeakButton text={T("greeting")} voice={sel} label={T("preview")} />
      </div>
    </div>
  );
}

// Quick "can we hear/speak your language?" info for the welcome step.
export function SpeechSupport() {
  const { lang } = usePrefs();
  const s = LANG_SUPPORT[lang];
  const stt = (s.stt === "full" || s.stt === "broad")
    ? { cls: "ok", txt: "✓ supported" }
    : s.stt === "adapt" ? { cls: "warn", txt: `≈ ${s.sttNote || "beta"}` }
    : { cls: "bad", txt: `✕ ${s.sttNote || "not supported"}` };
  const tts = (s.ttsPrefixes.length && !s.ttsNote)
    ? { cls: "ok", txt: "✓ supported" }
    : { cls: "warn", txt: `≈ ${s.ttsNote || "uses English"}` };
  return (
    <div className="speech-support">
      <span className={`sup ${stt.cls}`}>🎤 Speech&#8209;to&#8209;text: {stt.txt}</span>
      <span className={`sup ${tts.cls}`}>🔊 Read&#8209;aloud: {tts.txt}</span>
    </div>
  );
}
