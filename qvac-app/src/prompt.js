// Triage system prompt — ported from the repo's prompts/system_interview.txt /
// system_v4.txt work. The model is decision-support for a pharmacist (human-in-the-loop),
// must escalate red flags, de-escalate clearly benign cases, and emit a fixed structure.
// NOTE the explicit CONDITION line: we use that plain-language working diagnosis to look
// up the VERIFIED ICD-10 code (the model's own ICD-10 guess is unreliable — see ../README).

export const TRIAGE_SYSTEM = `You are a clinical decision-support tool for a registered community pharmacist. You support the pharmacist; you are NOT a standalone diagnostician and the pharmacist holds the final decision.

Assess the patient's presenting complaint and reply ONLY in this exact format, nothing else:
DECISION: <EMERGENCY | URGENT | PHARMACIST-LED | ROUTINE | INSUFFICIENT-DATA>
SEVERITY: <0-10 integer>
RED FLAGS: <those present, or "none identified">
CONDITION: <the single most likely working diagnosis, in plain clinical words>
ICD-10: <your best-guess WHO ICD-10 code for that condition>
ROUTING: <where this goes and why; consistent with DECISION>
SAFETY-NET: <what to watch for and when to seek urgent help>

Rules:
- SAFETY FLOOR: if a life-threatening red flag is present, DECISION is EMERGENCY regardless of framing.
- Do not over-escalate: once red flags are screened and absent, match urgency to findings (don't default to URGENT).
- If the input is too thin to decide, use INSUFFICIENT-DATA and state what is missing under SAFETY-NET.
- SEVERITY key: 8-10 RED/EMERGENCY, 5-7 AMBER/URGENT, 2-4 GREEN/PHARMACIST-LED, 0-1 GREEN/ROUTINE.
- CONDITION must be a real clinical condition name (used downstream for ICD-10 coding), not a code.
- Be concise. No preamble or sign-off.`;

// Extract the plain-language working diagnosis the model named, for ICD lookup.
export function extractCondition(text) {
  const m = text.match(/CONDITION:\s*(.+)/i);
  if (m) return m[1].trim().replace(/\(suspected\)/i, "").trim();
  const a = text.match(/RED FLAGS:\s*(.+)/i); // fallback
  return a ? a[1].trim() : "";
}

export function extractField(text, field) {
  const m = text.match(new RegExp(`${field}:\\s*(.+)`, "i"));
  return m ? m[1].trim() : "";
}

// Deterministic colour band — derived from DECISION (authoritative), severity as
// fallback. Fixes the model occasionally mislabelling the colour (e.g. sev 3 / AMBER).
const DECISION_COLOR = {
  EMERGENCY: "RED", URGENT: "AMBER", "PHARMACIST-LED": "GREEN",
  ROUTINE: "GREEN", "INSUFFICIENT-DATA": "AMBER",
};
export function bandFor(decision, severityText) {
  const byDecision = DECISION_COLOR[(decision || "").toUpperCase()];
  if (byDecision) return byDecision;
  const n = parseInt((String(severityText).match(/\d+/) || [])[0], 10);
  if (Number.isNaN(n)) return "";
  return n >= 8 ? "RED" : n >= 5 ? "AMBER" : "GREEN";
}

// First ICD-10-looking code in a string (e.g. medpsy's own guess).
export function extractIcdCode(text) {
  const m = String(text).match(/\b([A-TV-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?)\b/);
  return m ? m[1] : "";
}
