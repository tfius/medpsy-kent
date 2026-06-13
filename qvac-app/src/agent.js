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

You have on-device tools — USE them rather than relying on memory:
- lookup_icd10(condition): the VERIFIED ICD-10 code. NEVER state a code without calling this.
- search_knowledge(query): local protocols + drug-interaction monographs. Consult before advising; cite the returned source by name.
- check_interactions(medications): screen a medication list for interactions/cautions.

Screen red flags first and flag anything life-threatening for immediate escalation. Be concise and evidence-based, and state your uncertainty when information is incomplete. When you used search_knowledge, name the source document you relied on.`;

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

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { answer: "", history, aborted: true };
    const turn = await provider.chatWithTools(history, toolDefs, { signal });
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
