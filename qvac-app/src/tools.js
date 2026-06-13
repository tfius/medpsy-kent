// Agent tools — the on-device capabilities medpsy can CALL during an agent turn,
// wrapping the same verified server functions the scripted flow uses (ICD grounding,
// knowledge retrieval). Each tool is an OpenAI-style function definition + a run()
// that executes on-device. Shared so a future "ground the conclusion" triage step can
// reuse the exact same tools.
import { verifyIcd } from "./icd-index.js";
import { searchKnowledge } from "./knowledge.js";

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : s || "");

// Build the tool set bound to the live provider + ICD index (both already loaded by
// the server). Returns [{ def, run }]; def.function.name is the call name.
export function makeTools(provider, icdIndex) {
  return [
    {
      def: {
        type: "function",
        function: {
          name: "lookup_icd10",
          description: "Get the VERIFIED ICD-10 code(s) for a clinical condition from the on-device index. Always use this instead of guessing a code from memory.",
          parameters: {
            type: "object",
            properties: { condition: { type: "string", description: "the working diagnosis / condition in plain words, e.g. 'acute appendicitis'" } },
            required: ["condition"],
          },
        },
      },
      async run({ condition }) {
        if (!condition) return { error: "condition is required" };
        const results = await verifyIcd(String(condition), provider, icdIndex, 3);
        return { condition, candidates: results.map((r) => ({ code: r.code, description: r.description, score: r.score })) };
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "search_knowledge",
          description: "Search the local clinical knowledge base (drug-interaction monographs + local protocols) for relevant guidance. Use before advising; cite the returned source.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "what to look up, e.g. 'warfarin ibuprofen interaction' or 'chest pain protocol'" } },
            required: ["query"],
          },
        },
      },
      async run({ query }) {
        if (!query) return { error: "query is required" };
        const hits = await searchKnowledge(String(query), provider, 3);
        return { query, passages: hits.map((p) => ({ source: p.doc, score: p.score, text: trunc(p.content, 900) })) };
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "check_interactions",
          description: "Screen a list of medications for interactions and cautions using the local monographs. Returns the most relevant guidance passages.",
          parameters: {
            type: "object",
            properties: { medications: { type: "array", items: { type: "string" }, description: "medication names, e.g. ['warfarin','ibuprofen']" } },
            required: ["medications"],
          },
        },
      },
      async run({ medications }) {
        const list = Array.isArray(medications) ? medications.filter(Boolean) : [];
        if (!list.length) return { error: "medications must be a non-empty array" };
        const hits = await searchKnowledge(`interactions, cautions and contraindications for: ${list.join(", ")}`, provider, 4);
        return { medications: list, passages: hits.map((p) => ({ source: p.doc, score: p.score, text: trunc(p.content, 900) })) };
      },
    },
  ];
}
