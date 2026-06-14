// Agentic triage — a SEPARATE triage flow (not the scripted 9-step rail). medpsy conducts
// the interview itself: it asks questions, grounds with on-device tools, and finishes with a
// schema-enforced structured conclusion (the same TriageResult the scripted flow renders).
// Patient-facing conversation; the pharmacist reviews the outcome.
import { useEffect, useRef, useState } from "react";
import { runTriageTurn, toolLabel, outcomeToTriage, type TriageOutcome } from "../lib/atriage";
import { MicButton, SpeakButton } from "../lib/voice";
import { TriageResult, useHelp } from "../lib/ui";
import { usePrefs } from "../lib/prefs";
import { speak, stopSpeaking } from "../lib/speech";

type ToolStep = { id: string; name: string; args: Record<string, unknown>; result?: unknown };
type Turn = { who: "patient"; text: string } | { who: "agent"; text: string; reasoning: string; tools: ToolStep[] };

export default function AgenticTriage() {
  const { openHelp } = useHelp();
  const { autoSpeak } = usePrefs();
  const [started, setStarted] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TriageOutcome | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { abortRef.current?.abort(); stopSpeaking(); }, []);

  const patchAgent = (fn: (a: Extract<Turn, { who: "agent" }>) => void) =>
    setTurns((ts) => {
      const last = ts[ts.length - 1];
      if (last?.who !== "agent") return ts;
      const copy = { ...last }; fn(copy);
      return [...ts.slice(0, -1), copy];
    });

  async function go(message: string, reset = false) {
    const m = message.trim();
    if (!m || busy) return;
    setInput("");
    setTurns((ts) => [...ts, { who: "patient", text: m }, { who: "agent", text: "", reasoning: "", tools: [] }]);
    setBusy(true);
    const ac = new AbortController(); abortRef.current = ac;
    await runTriageTurn(m, (e) => {
      if (e.type === "reasoning") patchAgent((a) => { a.reasoning = (a.reasoning + "\n" + e.text).trim(); });
      else if (e.type === "tool_call") patchAgent((a) => { a.tools = [...a.tools, { id: e.id, name: e.name, args: e.args }]; });
      else if (e.type === "tool_result") patchAgent((a) => { a.tools = a.tools.map((t) => t.id === e.id ? { ...t, result: e.result } : t); });
      else if (e.type === "question") { patchAgent((a) => { a.text = e.text; }); if (autoSpeak) speak(e.text); }
      else if (e.type === "conclusion") { setOutcome(e.outcome); patchAgent((a) => { a.text = "✓ Assessment ready."; }); }
      else if (e.type === "error") patchAgent((a) => { a.text = `⚠ ${e.error}`; });
    }, { reset, signal: ac.signal });
    abortRef.current = null;
    setBusy(false);
  }

  function start(text: string) { setStarted(true); setOutcome(null); go(text, true); }
  function restart() { abortRef.current?.abort(); stopSpeaking(); setStarted(false); setTurns([]); setOutcome(null); setInput(""); setBusy(false); }

  return (
    <>
      <div className="eyebrow">Triage <span className="badge">agentic</span></div>
      <h1>Agentic triage</h1>
      <p className="lead">MedPsy conducts the interview itself — asking questions, checking your record and the
        on-device protocols/interaction graph, then reaching a verified assessment a pharmacist reviews.
        A separate, AI-led flow alongside the step-by-step triage.</p>

      {!started ? (
        <div className="card">
          <label htmlFor="c">What's bringing you in today? Describe your main symptom.</label>
          <textarea id="c" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. I've had a bad headache over my right temple for a week and my jaw aches when I chew." />
          <div className="row">
            <MicButton onText={(t) => start(t)} title="Describe by voice" />
            <button className="btn" onClick={() => start(input)} disabled={!input.trim()}>Start triage</button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="chat">
            {turns.map((t, i) => t.who === "patient" ? (
              <div key={i} className="bubble me">{t.text}</div>
            ) : (
              <div key={i}>
                {t.reasoning && (
                  <details className="thinking">
                    <summary>🧠 MedPsy's reasoning</summary>
                    <div className="think-body">{t.reasoning}</div>
                  </details>
                )}
                {t.tools.map((tool) => (
                  <details key={tool.id} className="thinking" style={{ borderLeftColor: "var(--amber, #c80)" }}>
                    <summary>🔧 {toolLabel(tool.name)}({Object.values(tool.args).map(String).join(", ").slice(0, 50)}){tool.result === undefined ? " …" : ""}</summary>
                    {tool.result !== undefined && <pre className="mono audit-raw">{JSON.stringify(tool.result, null, 1)}</pre>}
                  </details>
                ))}
                {t.text
                  ? <div className="bubble bot">{t.text}{!busy && t.text && !t.text.startsWith("✓") && <SpeakButton text={t.text} compact />}</div>
                  : (busy && i === turns.length - 1 && <div className="typing">interviewing…</div>)}
              </div>
            ))}
          </div>

          {!outcome && (
            <div className="row" style={{ marginTop: 8 }}>
              <input value={input} placeholder="Your answer…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && go(input)} disabled={busy} />
              <MicButton onText={(t) => go(t)} disabled={busy} title="Answer by voice" />
              <button className="btn" onClick={() => go(input)} disabled={busy || !input.trim()}>Send</button>
            </div>
          )}
        </div>
      )}

      {outcome && (
        <>
          <TriageResult t={outcomeToTriage(outcome)} view="clinician"
            onEmergency={outcome.band === "RED" ? () => openHelp(true) : undefined} />
          <div className="row"><button className="btn ghost" onClick={restart}>↻ New triage</button></div>
        </>
      )}
    </>
  );
}
