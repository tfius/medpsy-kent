// Agent — medpsy as a tool-calling assistant, running ALONGSIDE the scripted triage
// (not on the patient rail). The pharmacist asks free-form questions; medpsy calls the
// on-device tools (ICD grounding, knowledge base, interaction checks) and answers with
// the tool results shown inline. Clinician-facing, English.
import { useEffect, useRef, useState } from "react";
import { runAgent, toolLabel, type AgentMsg } from "../lib/agent";
import { logEvent } from "../lib/audit";

type ToolStep = { id: string; name: string; args: Record<string, unknown>; result?: unknown };
type Turn =
  | { who: "me"; text: string }
  | { who: "bot"; text: string; reasoning: string; tools: ToolStep[] };

const SUGGESTIONS = [
  "A patient on warfarin wants to buy ibuprofen for back pain — is that safe?",
  "What's the ICD-10 code for acute appendicitis?",
  "62-year-old diabetic woman, jaw ache, sweating, nausea, no chest pain. What should I do?",
];

export default function Agent() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const msgs = useRef<AgentMsg[]>([]); // conversation sent to the API (no system prompt)
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []); // cancel an in-flight stream on unmount

  // Update the last (bot) turn immutably as events stream in (no in-place mutation,
  // no side effects — so React 18 StrictMode double-invocation is safe).
  const patchBot = (fn: (b: Extract<Turn, { who: "bot" }>) => void) =>
    setTurns((ts) => {
      const last = ts[ts.length - 1];
      if (last?.who !== "bot") return ts;
      const copy = { ...last }; fn(copy);
      return [...ts.slice(0, -1), copy];
    });

  async function ask(text: string = input) {
    const q = text.trim();
    if (!q || busy) return;
    setInput(""); setBusy(true);
    setTurns((ts) => [...ts, { who: "me", text: q }, { who: "bot", text: "", reasoning: "", tools: [] }]);
    msgs.current.push({ role: "user", content: q });
    logEvent("agent.user", { text: q }, "clinician");

    let answer = "";
    const ac = new AbortController(); abortRef.current = ac;
    await runAgent(msgs.current, (e) => {
      if (e.type === "reasoning") patchBot((b) => { b.reasoning = (b.reasoning + "\n" + e.text).trim(); });
      else if (e.type === "tool_call") patchBot((b) => { b.tools = [...b.tools, { id: e.id, name: e.name, args: e.args }]; });
      else if (e.type === "tool_result") patchBot((b) => { b.tools = b.tools.map((t) => t.id === e.id ? { ...t, result: e.result } : t); });
      else if (e.type === "answer") { answer = e.text; patchBot((b) => { b.text = e.text; }); }
      else if (e.type === "error") patchBot((b) => { b.text = `⚠ ${e.error}`; });
    }, ac.signal);
    abortRef.current = null;

    // Persist the assistant answer for the next turn (a plain ref write, NOT inside a
    // setState updater — updaters must stay pure / can run twice).
    if (answer) msgs.current.push({ role: "assistant", content: answer });
    else patchBot((b) => { if (!b.text) b.text = "⚠ No response."; });
    setBusy(false);
  }

  function reset() { abortRef.current?.abort(); abortRef.current = null; setTurns([]); msgs.current = []; setInput(""); setBusy(false); }

  return (
    <>
      <div className="eyebrow">Agent <span className="badge">tools</span></div>
      <h1>Ask MedPsy</h1>
      <p className="lead">Free-form clinical questions. MedPsy reasons and calls on-device tools —
        verified ICD-10 lookup, the local knowledge base, and interaction checks — then answers with
        the sources it used. Runs alongside the structured triage; the pharmacist decides.</p>

      <div className="card">
        <div className="chat">
          {!turns.length && (
            <div className="note" style={{ display: "grid", gap: 6 }}>
              <span>Try:</span>
              {SUGGESTIONS.map((s) => (
                <button key={s} className="btn ghost" style={{ textAlign: "left" }} onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          )}
          {turns.map((t, i) => t.who === "me" ? (
            <div key={i} className="bubble me">{t.text}</div>
          ) : (
            <div key={i}>
              {t.reasoning && (
                <details className="thinking">
                  <summary>🧠 reasoning</summary>
                  <div className="think-body">{t.reasoning}</div>
                </details>
              )}
              {t.tools.map((tool) => (
                <details key={tool.id} className="thinking" style={{ borderLeftColor: "var(--amber, #c80)" }}>
                  <summary>🔧 {toolLabel(tool.name)}({Object.values(tool.args).map(String).join(", ").slice(0, 60)}){tool.result === undefined ? " …" : ""}</summary>
                  {tool.result !== undefined && <pre className="mono audit-raw">{JSON.stringify(tool.result, null, 1)}</pre>}
                </details>
              ))}
              {t.text
                ? <div className="bubble bot">{t.text}</div>
                : (busy && i === turns.length - 1 && <div className="typing">thinking…</div>)}
            </div>
          ))}
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <input value={input} placeholder="Ask a clinical question…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()} disabled={busy} />
          <button className="btn" onClick={() => ask()} disabled={busy || !input.trim()}>Ask</button>
        </div>
        {turns.length > 0 && (
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={reset} disabled={busy}>↻ New conversation</button>
          </div>
        )}
      </div>
    </>
  );
}
