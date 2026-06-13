// Agent get/put tools over a FactStore, bound to one log (partition). Returns the
// [{ def, run }] shape the kiosk's agent loop already iterates, so wiring is one spread.
// Domain-agnostic — a lens can wrap these with typed helpers (e.g. get_patient_context).
//
// WRITE-GATING (the dangerous part — letting an LLM write facts):
//   "none"    — read only (recall / recall_timeline / related)
//   "propose" — + remember, but agent facts land as source:agent, confidence 0.5, meta.proposed
//   "full"    — + end_fact / correct_fact (changing existing facts)
// `subject` (optional) is a default subject id applied when a tool call omits one — so an
// agent bound to one patient's log can `recall()` / `remember(...)` without knowing the id.
export function makeFactstoreTools(store, { log, subject: defaultSubject, allowWrite = "none" } = {}) {
  if (!log) throw new Error("makeFactstoreTools requires { log }");
  // A bound subject is AUTHORITATIVE: it overrides whatever the model passes (so the agent
  // can't query a hallucinated id), and it's omitted from the tool schema so the model
  // never invents one. Unbound, the model chooses the subject freely.
  const subj = (s) => defaultSubject ?? s;
  const bound = defaultSubject != null;
  // subject param, included only when there's no bound subject:
  const subjectParam = bound ? {} : { subject: { type: "string", description: "entity id, e.g. 'patient:123'" } };
  const here = bound ? " about the current patient" : "";

  const tools = [
    {
      def: { type: "function", function: {
        name: "recall",
        description: `Get the currently-known facts${here} (optionally filtered by predicate, optionally as of a past date). Returns the facts plus a receipt of the exact statements used.`,
        parameters: { type: "object", properties: {
          ...subjectParam,
          predicate: { type: "string", description: "relation to filter by, e.g. 'takes' (optional)" },
          asOf: { type: "string", description: "ISO date/datetime to evaluate validity at (default: now)" },
        } } } },
      run: ({ subject, predicate, asOf }) => store.fold(log, { subject: subj(subject), predicate, validAt: asOf }),
    },
    {
      def: { type: "function", function: {
        name: "recall_timeline",
        description: `Get the full history (every change over time) of facts${here}, optionally filtered by predicate.`,
        parameters: { type: "object", properties: {
          ...subjectParam, predicate: { type: "string" },
        } } } },
      run: async ({ subject, predicate }) => ({ timeline: await store.timeline(log, { subject: subj(subject), predicate }) }),
    },
    {
      def: { type: "function", function: {
        name: "related",
        description: `Get one-hop related entities (graph edges)${here ? " from the current patient" : " from a subject"} — facts whose object is a reference.`,
        parameters: { type: "object", properties: {
          ...subjectParam, predicate: { type: "string" },
        }, ...(bound ? {} : { required: ["subject"] }) } } },
      run: async ({ subject, predicate }) => ({ edges: await store.neighbors(log, subj(subject), { predicate }) }),
    },
  ];

  if (allowWrite !== "none") {
    const confidence = allowWrite === "propose" ? 0.5 : 1;
    tools.push({
      def: { type: "function", function: {
        name: "remember",
        description: `Record a new fact${here}. ` + (allowWrite === "propose" ? "Recorded as an agent PROPOSAL (low confidence, pending clinician confirmation). " : "") + "Use validFrom for when the fact became true.",
        parameters: { type: "object", properties: {
          ...subjectParam, predicate: { type: "string" },
          object: { description: "the fact's value — a literal, or { ref: '<id>' } for a relationship" },
          validFrom: { type: "string", description: "ISO date when the fact became true (optional)" },
        }, required: [...(bound ? [] : ["subject"]), "predicate", "object"] } } },
      run: async ({ subject, predicate, object, validFrom }) => {
        const r = await store.assert(log, { subject: subj(subject), predicate, object, validFrom: validFrom ?? null,
          source: "agent", actor: "model", confidence, meta: { proposed: allowWrite === "propose" } });
        // Carry the proposal flag so the encounter audit records an agent-PROPOSED fact
        // distinctly from a confirmed one (the "pending confirmation" provenance).
        return { recorded: { statementId: r.payload.statementId, hash: r.hash, proposed: allowWrite === "propose", confidence } };
      },
    });
  }

  if (allowWrite === "full") {
    tools.push({
      def: { type: "function", function: {
        name: "end_fact",
        description: "Mark a fact as no longer true from a given date (e.g. a medication that was stopped).",
        parameters: { type: "object", properties: {
          statementId: { type: "string" }, validTo: { type: "string", description: "ISO date the fact stopped being true" },
        }, required: ["statementId", "validTo"] } } },
      run: async ({ statementId, validTo }) => {
        const r = await store.end(log, statementId, validTo, { source: "agent", actor: "model" });
        return { ended: { statementId, hash: r.hash } };
      },
    });
    tools.push({
      def: { type: "function", function: {
        name: "correct_fact",
        description: "Correct the recorded value of a fact (a system correction; history is preserved).",
        parameters: { type: "object", properties: {
          statementId: { type: "string" }, object: { description: "the corrected value" },
        }, required: ["statementId", "object"] } } },
      run: async ({ statementId, object }) => {
        const r = await store.correct(log, statementId, { object, source: "agent", actor: "model" });
        return { corrected: { statementId, hash: r.hash } };
      },
    });
  }

  return tools;
}
