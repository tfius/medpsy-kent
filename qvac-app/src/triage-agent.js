// Agentic triage — medpsy CONDUCTS the triage interview itself, grounding with the same
// on-device tools the /agent loop uses (recall patient facts, search protocols, screen
// interactions, verified ICD lookup), and finishing by calling a `conclude` tool whose
// JSON schema IS the structured outcome (schema-enforced, not regex-parsed). This is a
// SEPARATE flow from the scripted 9-step triage — it does not touch it.
//
// Loop per call: the model either (a) calls grounding tools (execute, feed back, keep
// going), (b) calls conclude (terminal — verify the ICD, return the outcome), or (c)
// replies in plain text, which is a QUESTION to the patient — we return it and pause for
// the patient's answer (the server holds the conversation in a per-encounter session).
import { makeTools } from "./tools.js";
import { persistentTurn } from "./agent.js";
import { verifyIcd } from "./icd-index.js";

export const TRIAGE_AGENT_SYSTEM = `You are MedPsy conducting a short TRIAGE INTERVIEW with a patient at a community pharmacy. You support a registered pharmacist, who makes the final decision; you are NOT a standalone diagnostician.

Conduct the interview yourself: ask ONE focused question at a time, and reply with ONLY that question (no preamble, no labels) — your plain-text replies are shown DIRECTLY to the patient. Screen red flags first: onset/timing, character/severity, associated features, relevant history and medications.

Ground your reasoning with tools as you go (tool calls are NOT shown to the patient):
- recall() — check what is already known about THIS patient (medications, conditions, allergies) before you start.
- search_knowledge(query) — consult the local protocols (chest pain, anticoagulated head injury, paediatric fever, …) and drug monographs before deciding.
- screen_interactions(candidate) — check a drug against the patient's recorded medications.
- lookup_icd10(condition) — the verified ICD-10 code.

Reply with ONLY the question text the patient should read — NO reasoning, NO explanation, NO labels.

The moment a clear life-threatening red flag is present, STOP asking and conclude. Once red flags are screened and absent, DE-ESCALATE to match the findings — do not default to URGENT.

When you have enough (usually after 2–4 questions), FINISH the triage by calling the conclude() tool. If you are unable to call the tool, instead output a SINGLE JSON object and nothing else: {"decision": "...", "severity": 0-10, "condition": "...", "icd": "...", "redFlags": "...", "routing": "...", "safetyNet": "..."}.`;

// conclude's parameters ARE the structured triage outcome (forced JSON via the tools API).
const CONCLUDE_DEF = {
  type: "function",
  function: {
    name: "conclude",
    description: "Finish the triage with a structured assessment. Call this (do NOT write the conclusion as plain text) once you have enough information.",
    parameters: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["EMERGENCY", "URGENT", "PHARMACIST-LED", "ROUTINE", "INSUFFICIENT-DATA"], description: "triage band decision" },
        severity: { type: "integer", minimum: 0, maximum: 10 },
        condition: { type: "string", description: "single most likely working diagnosis, plain words" },
        icd: { type: "string", description: "your best ICD-10 code (it is re-verified against the condition)" },
        redFlags: { type: "string", description: "red flags present, or 'none identified'" },
        routing: { type: "string", description: "where this goes and why" },
        safetyNet: { type: "string", description: "what to watch for and when to seek urgent help" },
      },
      required: ["decision", "severity", "condition", "routing", "safetyNet"],
    },
  },
};

// medpsy in a long interview sometimes writes the conclude as TEXT JSON instead of a native
// tool call ({"name":"conclude","arguments":{…}} or a bare {decision,…}). Recover it.
function parseTextConclude(text) {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const o = JSON.parse(m[0]); if (o.arguments?.decision) return o.arguments; if (o.decision) return o; } catch { /* not JSON */ }
  return null;
}

// First balanced JSON object in a reply — robust to a leading <think> block and trailing prose
// (a greedy /\{[\s\S]*\}/ over-matches and fails to parse). Ignores braces inside strings.
function extractJsonObj(text) {
  const s = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

// Acuity ordering for the safety gate. The supervisor may only RAISE acuity (escalate), never
// silently lower it — so the gate can make a conclusion safer but never less safe.
const ACUITY = { ROUTINE: 0, "PHARMACIST-LED": 1, "INSUFFICIENT-DATA": 1, URGENT: 2, EMERGENCY: 3 };

// Map a model-emitted disposition label to the canonical enum. Models phrase escalation many ways
// ("A&E", "999", "refer to ED", "same-day") — without this, an off-enum label scores acuity −1 and
// a real escalation gets SILENTLY DROPPED. Returns a canonical decision, or null if unrecognizable.
const DECISION_SYNONYMS = [
  [/EMERGENC|\b999\b|\b911\b|RESUS|ANAPHYLAX|BLUE.?LIGHT|AMBULANCE|\bA&E\b|A AND E|\bED\b|\bER\b/, "EMERGENCY"],
  [/URGENT|SAME.?DAY|\b111\b|REFER|ESCALAT|HOSPITAL/, "URGENT"],
  [/PHARMAC/, "PHARMACIST-LED"],
  [/ROUTINE|SELF.?CARE|\bGP\b|HOME/, "ROUTINE"],
  [/INSUFFICIENT|UNCLEAR|UNKNOWN|MORE INFO/, "INSUFFICIENT-DATA"],
];
function normDecision(d) {
  const s = String(d || "").toUpperCase().trim();
  if (!s) return null;
  if (ACUITY[s] !== undefined) return s;
  for (const [re, label] of DECISION_SYNONYMS) if (re.test(s)) return label;
  return null;
}

// Compact, PHI-light recap of what the interview gathered (patient answers + the on-device tool
// results that grounded the reasoning) — the evidence the safety reviewer re-reads.
function summarizeEvidence(history) {
  const lines = [];
  for (const m of history) {
    if (m.role === "user") lines.push(`patient: ${String(m.content).slice(0, 200)}`);
    else if (m.role === "assistant" && m.content && !(m.tool_calls?.length)) lines.push(`assistant asked: ${String(m.content).slice(0, 160)}`);
    else if (m.role === "tool") {
      let r; try { r = JSON.parse(m.content); } catch { r = m.content; }
      lines.push(`tool ${m.name || ""}: ${String(typeof r === "string" ? r : JSON.stringify(r)).slice(0, 280)}`);
    }
  }
  return lines.join("\n").slice(0, 2500);
}

// SELF-CORRECTION + ESCALATION: a SECOND, independent medpsy pass acting as a supervising
// clinician that re-reads the gathered evidence and the proposed conclusion and may overrule it
// — but only to make it SAFER (catch under-triage / missed red flags). Returns
// { agree, decision, severity, missedRedFlags, rationale }. Fails OPEN (agree) on error/parse
// failure: a reviewer glitch must not block the pharmacist from seeing the agent's own outcome.
export async function superviseConclusion(provider, { args, evidence }) {
  if (typeof provider.complete !== "function") return { agree: true, skipped: "no complete()" };
  const sys = "You are a SENIOR supervising clinician performing an INDEPENDENT SAFETY REVIEW of a triage assistant's proposed conclusion before it reaches the pharmacist. Be skeptical and conservative: your single job is to catch UNDER-triage and missed red flags. You may only make the outcome SAFER (higher acuity), never less. If a red flag is PLAUSIBLE but was not confirmed or excluded by the interview, prefer to ASK ONE more targeted question to resolve it rather than guessing. If the proposed conclusion is already appropriately safe, AGREE.";
  const proposed = { decision: args.decision, severity: args.severity, condition: args.condition, redFlags: args.redFlags, routing: args.routing };
  const user = `Evidence gathered during the interview:\n${evidence || "(none captured)"}\n\nProposed conclusion:\n${JSON.stringify(proposed)}\n\nReview it for patient safety. Reply with ONLY a JSON object and nothing else:\n{"agree": true|false, "decision": "EMERGENCY|URGENT|PHARMACIST-LED|ROUTINE|INSUFFICIENT-DATA", "severity": 0-10, "missedRedFlags": "<text or 'none'>", "askInstead": "<ONE direct question to the PATIENT that would confirm or exclude a suspected red flag, or empty string if none needed>", "rationale": "<one sentence>"}`;
  let text = "";
  try { text = await provider.complete([{ role: "system", content: sys }, { role: "user", content: user }], { temperature: 0.2 }); }
  catch (e) { return { agree: true, error: String(e?.message || e) }; }
  const v = extractJsonObj(text);
  if (!v) return { agree: true, unparsed: true };
  return { agree: v.agree !== false, decision: String(v.decision || "").toUpperCase(), severity: v.severity, missedRedFlags: String(v.missedRedFlags || ""), askInstead: String(v.askInstead || "").trim(), rationale: String(v.rationale || "").slice(0, 240) };
}

// medpsy often puts its reasoning before the actual question. The PATIENT should see only
// the question, but the reasoning is valuable — we SPLIT it (not discard it) so it can be
// shown collapsed and written to the audit trail.
function splitQuestion(reply) {
  const qi = reply.lastIndexOf("?");
  if (qi === -1) {
    const lines = reply.split("\n").map((l) => l.trim()).filter(Boolean);
    return { reasoning: lines.slice(0, -1).join("\n"), question: lines[lines.length - 1] || reply.trim() };
  }
  const head = reply.slice(0, qi);
  const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return { reasoning: reply.slice(0, cut + 1).trim(), question: reply.slice(cut + 1, qi + 1).trim() };
}

const DECISION_COLOR = { EMERGENCY: "RED", URGENT: "AMBER", "PHARMACIST-LED": "GREEN", ROUTINE: "GREEN", "INSUFFICIENT-DATA": "AMBER" };
function bandFor(decision, severity) {
  const d = DECISION_COLOR[(decision || "").toUpperCase()];
  if (d) return d;
  const n = parseInt(severity, 10);
  return Number.isNaN(n) ? "" : n >= 8 ? "RED" : n >= 5 ? "AMBER" : "GREEN";
}

// Turn the model's conclude args into the verified outcome — the ICD is re-grounded against
// the stated condition (the agent's own code is kept as icdGuess).
async function finalizeConclusion(args, { provider, icdIndex }) {
  const decision = String(args.decision || "INSUFFICIENT-DATA").toUpperCase();
  const condition = String(args.condition || "").trim();
  const guess = String(args.icd || "").trim();
  let icd = guess, icdDescription = "";
  try {
    if (condition) {
      const res = await verifyIcd(condition, provider, icdIndex, 1);
      if (res?.[0]) { icd = res[0].code; icdDescription = res[0].description || ""; }
    }
  } catch { /* keep the agent's guess if verification fails */ }
  return {
    decision, severity: Number(args.severity ?? 5), band: bandFor(decision, args.severity),
    condition, icd, icdGuess: guess, icdDescription,
    redFlags: String(args.redFlags || "none identified"),
    routing: String(args.routing || ""), safetyNet: String(args.safetyNet || ""),
  };
}

// Run the interview from the conversation so far until the agent asks a QUESTION or
// CONCLUDES. Returns { question?, outcome?, messages } (messages = updated conversation
// WITHOUT the system prompt, for the session to store), or { aborted } / { error }.
export async function runTriageAgent({ provider, icdIndex, extraTools = [], messages, onEvent = () => {}, maxSteps = 12, signal, retries = 6, context = "", supervise = true, supervisorAsksLeft = 1, consultFn = null }) {
  const ground = [...makeTools(provider, icdIndex), ...extraTools];
  const toolDefs = [...ground.map((t) => t.def), CONCLUDE_DEF];
  const byName = Object.fromEntries(ground.map((t) => [t.def.function.name, t]));
  // Pre-injected patient context (recalled facts) so the interview is patient-aware even if
  // the model doesn't call recall itself.
  const sys = TRIAGE_AGENT_SYSTEM + (context ? `\n\nKnown about THIS patient (already on file — use it; you need not ask about these):\n${context}` : "");
  const history = [{ role: "system", content: sys }, ...messages];
  const strip = () => history.slice(1);

  // Conclude THROUGH a safety gate: an independent supervisor re-reads the evidence and may, in
  // order, (1) ask ONE more targeted question to resolve a plausible-but-unconfirmed red flag
  // (bounded by `reaskLeft`), (2) escalate the outcome (only — never de-escalate), and (3) when
  // the case is escalating/uncertain, autonomously fetch a peer's second opinion over the mesh.
  // Every step is auditable (`critique` / `question` / `consult` events); the merge is
  // safety-biased throughout. `reaskLeft` is 0 on the forced fallback so it always terminates.
  const conclude = async (rawArgs, { reaskLeft = supervisorAsksLeft } = {}) => {
    let args = rawArgs, supervised = null, consult = null;
    if (supervise) {
      const v = await superviseConclusion(provider, { args, evidence: summarizeEvidence(history) });
      onEvent({ type: "critique", verdict: v });
      const orig = String(args.decision || "INSUFFICIENT-DATA").toUpperCase();

      // (1) Plausible red flag not yet confirmed/excluded → ask ONE more question instead of
      // guessing, while budget remains. The answer comes back as the next patient turn.
      if (!v.agree && v.askInstead && reaskLeft > 0) {
        history.push({ role: "assistant", content: v.askInstead });
        onEvent({ type: "question", text: v.askInstead });
        return { question: v.askInstead, supervisorAsk: true, reason: v.rationale || "", messages: strip() };
      }

      // (2) Safety-biased escalation: the supervisor may only RAISE acuity. A disagreement whose
      // decision label we can't map is treated as a CONSERVATIVE escalation to URGENT rather than
      // dropped — so an off-enum "REFER"/"A&E"/"999" never silently keeps a ROUTINE band.
      const supDec = normDecision(v.decision);
      const supAcuity = !v.agree ? (supDec ? ACUITY[supDec] : ACUITY.URGENT) : -1;
      const escalate = supAcuity > (ACUITY[orig] ?? 1);
      if (escalate) {
        const newDec = supDec && ACUITY[supDec] !== undefined ? supDec : "URGENT";
        args = { ...args, decision: newDec,
          severity: Math.max(Number(args.severity) || 0, Number(v.severity) || 0, ACUITY[newDec] >= ACUITY.URGENT ? 6 : 0),
          redFlags: v.missedRedFlags && !/^\s*none/i.test(v.missedRedFlags) ? v.missedRedFlags : args.redFlags,
          routing: `${String(args.routing || "").trim()} [Safety review escalated: ${v.rationale || "missed red flag"}]`.trim() };
      }
      const reviewerFailed = !!(v.error || v.unparsed || v.skipped);
      supervised = { agreed: !!v.agree, escalated: escalate, from: orig, missedRedFlags: v.missedRedFlags || "", rationale: v.rationale || "", error: v.error || v.unparsed || v.skipped || null };

      // (3) Autonomous peer second opinion when uncertain (the supervisor escalated, the
      // disposition is itself low-confidence, OR the reviewer FAILED — so a reviewer outage
      // doesn't disable both safety layers at once) and a consult peer is reachable. Advisory:
      // attached for the pharmacist + audited, and can only RAISE the band, never lower it.
      const finalDec = String(args.decision || "").toUpperCase();
      const uncertain = escalate || reviewerFailed || orig === "INSUFFICIENT-DATA" || finalDec === "INSUFFICIENT-DATA";
      if (consultFn && uncertain) {
        consult = await consultFn({ args, rationale: v.rationale || "" }).catch(() => null);
        if (consult?.answer) {
          onEvent({ type: "consult", consult });
          // A peer can only RAISE the band (URGENT, or EMERGENCY if the peer clearly signals it),
          // attributed to the peer (the consult card + this routing note), never to the
          // supervisor's `escalated` flag and never downward.
          if (consult.escalate) {
            const target = consult.emergency ? "EMERGENCY" : "URGENT";
            if (ACUITY[target] > (ACUITY[finalDec] ?? 1)) {
              args = { ...args, decision: target, severity: Math.max(Number(args.severity) || 0, consult.emergency ? 9 : 6),
                routing: `${String(args.routing || "").trim()} [Peer second opinion advised escalation]`.trim() };
            }
          }
        }
      }
    }
    const outcome = await finalizeConclusion(args, { provider, icdIndex });
    if (supervised) outcome.supervised = supervised;
    if (consult) outcome.consult = consult;
    onEvent({ type: "conclusion", outcome });
    return { outcome, messages: strip() };
  };

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { aborted: true, messages: strip() };
    const turn = await persistentTurn(provider, history, toolDefs, { signal, retries });
    if (turn.aborted) return { aborted: true, messages: strip() };
    if (turn.reasoning) onEvent({ type: "reasoning", text: turn.reasoning });

    if (turn.toolCalls?.length) {
      const cc = turn.toolCalls.find((tc) => tc.function?.name === "conclude");
      if (cc) { let a = {}; try { a = JSON.parse(cc.function?.arguments || "{}"); } catch { /* use defaults */ } return conclude(a); }
      history.push({ role: "assistant", content: turn.content || "", tool_calls: turn.toolCalls });
      for (const tc of turn.toolCalls) {
        const name = tc.function?.name;
        let args = {}, parseErr = null;
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch (e) { parseErr = e; }
        onEvent({ type: "tool_call", id: tc.id, name, args });
        const result = parseErr ? { error: `could not parse arguments: ${String(tc.function?.arguments).slice(0, 200)}` }
          : byName[name] ? await byName[name].run(args).catch((e) => ({ error: String(e?.message || e) }))
          : { error: `unknown tool '${name}'` };
        onEvent({ type: "tool_result", id: tc.id, name, result });
        history.push({ role: "tool", tool_call_id: tc.id, name, content: JSON.stringify(result) });
      }
      continue;
    }

    const raw = (turn.content || "").trim();
    if (!raw) { onEvent({ type: "error", error: "the model returned an empty response after retries" }); return { error: true, messages: strip() }; }
    const textConclude = parseTextConclude(raw); // the model may have written conclude as text
    if (textConclude) return conclude(textConclude);
    // Separate the reasoning the model put before the question — keep it (collapsed + audit),
    // show the patient only the question.
    const { reasoning, question: q } = splitQuestion(raw);
    if (reasoning) onEvent({ type: "reasoning", text: reasoning });
    history.push({ role: "assistant", content: q });
    onEvent({ type: "question", text: q });
    return { question: q, messages: strip() };
  }

  // Ran out of steps without concluding — push for a conclusion, then fall back. These are the
  // forced terminal conclusions: reaskLeft:0 so the gate can escalate/consult but never bounce
  // the interview back to another question (which would risk never terminating).
  history.push({ role: "user", content: "You have asked enough questions. Call conclude() now with your best assessment based on what you know." });
  const turn = await persistentTurn(provider, history, toolDefs, { signal, retries });
  const cc = (turn.toolCalls || []).find((tc) => tc.function?.name === "conclude");
  if (cc) { let a = {}; try { a = JSON.parse(cc.function?.arguments || "{}"); } catch { /* defaults */ } return conclude(a, { reaskLeft: 0 }); }
  const textCc = parseTextConclude(turn.content || "");
  if (textCc) return conclude(textCc, { reaskLeft: 0 });
  return conclude({ decision: "INSUFFICIENT-DATA", severity: 5, condition: turn.content?.slice(0, 80) || "unclear", routing: "Pharmacist review — interview inconclusive.", safetyNet: "Seek medical help if symptoms worsen or new red flags appear." }, { reaskLeft: 0 });
}
