// medpsy as a tool-calling agent — a free-form clinical-reasoning loop that runs
// ALONGSIDE the scripted 9-step triage (not replacing it). The model decides when to
// call the on-device tools (ICD grounding, knowledge retrieval, interaction checks);
// we execute them locally and feed results back until it produces a final answer.
//
// Backend-agnostic: it calls provider.chatWithTools(history, toolDefs, opts) -> one
// assistant turn { content, toolCalls, reasoning }. The LM Studio provider implements
// it via the OpenAI tools API (medpsy-4b emits native tool_calls); the QVAC SDK path
// can implement the same shape with the SDK's native tools.
import { makeTools } from "./tools.js";

export const AGENT_SYSTEM = `You are MedPsy, a clinical decision-support assistant for a registered community pharmacist. You support the pharmacist's decision; you are NOT a standalone diagnostician, and the pharmacist makes the final call.

USE your on-device tools rather than relying on memory, in this order:
1. recall() — ALWAYS start by recalling what is already known about THIS patient (current medications, conditions, allergies). Ground your answer in these confirmed facts; do not assume meds the patient isn't recorded as taking.
2. screen_interactions(candidate) — for ANY "is drug X safe / can they take X" question, use this. It checks X against the patient's recorded meds via the verified interaction graph. Prefer it over check_interactions for patient-specific safety.
3. lookup_icd10(condition) — the VERIFIED ICD-10 code. NEVER state a code without calling this.
4. search_knowledge(query) — local protocols + drug-interaction monographs for detail/rationale. Cite the returned source document by name.

Always cite what grounded your answer: the recalled facts and/or the source documents/interaction edges. Screen red flags first and flag anything life-threatening for immediate escalation. Be concise and evidence-based; state your uncertainty when information is incomplete. If you record a new fact about the patient (remember), say it is a PROPOSAL pending the pharmacist's confirmation.`;

// Run the agent loop. `messages` is the conversation so far ({role,content}[]). onEvent
// is called with {type, ...} events: "reasoning", "tool_call", "tool_result", "answer".
// Returns { answer, history } (history includes the tool turns, for multi-turn continuation).
export async function runAgent({ provider, icdIndex, messages, onEvent = () => {}, maxSteps = 6, signal, extraTools = [] }) {
  if (typeof provider.chatWithTools !== "function") {
    throw new Error(`backend ${provider.name} has no tool-calling support`);
  }
  const tools = [...makeTools(provider, icdIndex), ...extraTools];
  const toolDefs = tools.map((t) => t.def);
  const byName = Object.fromEntries(tools.map((t) => [t.def.function.name, t]));
  const history = [{ role: "system", content: AGENT_SYSTEM }, ...messages];

  // Stream the final answer token-by-token when the backend supports it. A tool-call turn
  // emits no content (so no answer_delta); only the answer turn streams.
  const stream = typeof provider.chatWithToolsStream === "function";
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { answer: "", history, aborted: true };
    const turn = stream
      ? await provider.chatWithToolsStream(history, toolDefs, { signal }, (t) => onEvent({ type: "answer_delta", text: t }))
      : await provider.chatWithTools(history, toolDefs, { signal });
    if (signal?.aborted) return { answer: "", history, aborted: true };
    if (turn.reasoning) onEvent({ type: "reasoning", text: turn.reasoning });

    if (turn.toolCalls?.length) {
      // Keep the assistant's tool-call turn in history (required before the tool results).
      history.push({ role: "assistant", content: turn.content || "", tool_calls: turn.toolCalls });
      for (const tc of turn.toolCalls) {
        const name = tc.function?.name;
        let args = {}, parseErr = null;
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch (e) { parseErr = e; }
        onEvent({ type: "tool_call", id: tc.id, name, args });
        let result;
        // Tell the model when ITS arguments were malformed (don't run with {} and report a
        // misleading "missing field" — it would just re-issue the same broken call).
        if (parseErr) result = { error: `could not parse arguments: ${String(tc.function?.arguments).slice(0, 200)}` };
        else if (!byName[name]) result = { error: `unknown tool '${name}'` };
        else { try { result = await byName[name].run(args); } catch (e) { result = { error: String(e?.message || e) }; } }
        onEvent({ type: "tool_result", id: tc.id, name, result });
        history.push({ role: "tool", tool_call_id: tc.id, name, content: JSON.stringify(result) });
      }
      continue; // let the model reason over the tool results
    }

    const text = turn.content || "";
    if (!text) {
      // No tool call and no answer — a failed/empty generation, not a real reply.
      onEvent({ type: "error", error: "the model returned an empty response" });
      return { answer: "", history };
    }
    onEvent({ type: "answer", text });
    return { answer: text, history };
  }

  const msg = "Stopped after the maximum number of tool steps without a final answer. Please rephrase or narrow the question.";
  onEvent({ type: "answer", text: msg });
  return { answer: msg, history };
}
