// Triage as a multi-step duel: medpsy plays the pharmacist, asks ONE question at a
// time, and concludes with a structured block. Ported from the repo's
// prompts/system_interview.txt. The colour band is derived deterministically.
import type { Msg } from "./openai";

export const TRIAGE_SYSTEM = `You are a clinical decision-support tool for a registered community pharmacist, conducting a short TRIAGE INTERVIEW with a patient. You support the pharmacist; you are NOT a standalone diagnostician.

Ask ONE focused question at a time (two only if tightly related). Screen red flags first: onset/timing, character/severity, associated features, relevant history and medications. Keep each question to one or two short sentences. Do NOT give your assessment until you have enough to decide.

The moment a clear life-threatening red flag is present, stop asking and conclude. Once red flags are screened and absent, DE-ESCALATE to match the findings — do not default to URGENT.

When you have enough (usually after 2–4 questions), STOP asking and reply ONLY with this block, nothing else:
DECISION: <EMERGENCY | URGENT | PHARMACIST-LED | ROUTINE | INSUFFICIENT-DATA>
SEVERITY: <0-10 integer>
RED FLAGS: <those present, or "none identified">
CONDITION: <single most likely working diagnosis, plain words>
ICD-10: <your best-guess code>
ROUTING: <where this goes and why>
SAFETY-NET: <what to watch for and when to seek urgent help>

Otherwise, reply with just your next question (no labels, no preamble).`;

export type Triage = {
  decision: string;
  severity: string;
  band: "RED" | "AMBER" | "GREEN" | "";
  redFlags: string;
  condition: string;
  icd: string;
  routing: string;
  safetyNet: string;
};

const DECISION_COLOR: Record<string, "RED" | "AMBER" | "GREEN"> = {
  EMERGENCY: "RED", URGENT: "AMBER", "PHARMACIST-LED": "GREEN", ROUTINE: "GREEN", "INSUFFICIENT-DATA": "AMBER",
};

export function bandFor(decision: string, severity: string): "RED" | "AMBER" | "GREEN" | "" {
  const d = DECISION_COLOR[(decision || "").toUpperCase()];
  if (d) return d;
  const n = parseInt((severity.match(/\d+/) || [""])[0], 10);
  if (Number.isNaN(n)) return "";
  return n >= 8 ? "RED" : n >= 5 ? "AMBER" : "GREEN";
}

const field = (t: string, k: string) =>
  (t.match(new RegExp(`${k}:\\s*(.+)`, "i"))?.[1] || "").replace(/[*#`<>]/g, "").trim();

// nudge to force a conclusion (turn cap or manual "Conclude now")
export const CONCLUDE_NUDGE =
  "You now have enough information. Stop asking and reply ONLY with the conclusion block " +
  "(DECISION / SEVERITY / RED FLAGS / CONDITION / ICD-10 / ROUTING / SAFETY-NET).";

export function isConclusion(text: string): boolean {
  return /DECISION:/i.test(text);
}

// Reasoning models sometimes leak untagged chain-of-thought before the actual question
// ("Okay, let's see… Do you have X?"). Keep only the trailing question the patient should see.
export function questionText(reply: string): string {
  const q = reply.lastIndexOf("?");
  if (q === -1) {
    const lines = reply.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] || reply.trim();
  }
  const head = reply.slice(0, q);
  const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return reply.slice(cut + 1, q + 1).trim();
}

export function parseTriage(text: string): Triage {
  const decision = (field(text, "DECISION").match(/[A-Z-]+/) || [""])[0];
  const severity = field(text, "SEVERITY");
  return {
    decision,
    severity,
    band: bandFor(decision, severity),
    redFlags: field(text, "RED FLAGS"),
    condition: field(text, "CONDITION"),
    icd: field(text, "ICD-10"),
    routing: field(text, "ROUTING"),
    safetyNet: field(text, "SAFETY-NET"),
  };
}

export const seed = (complaint: string, intake?: string): Msg[] => [
  { role: "system", content: TRIAGE_SYSTEM },
  { role: "user", content: intake ? `${complaint}\n\n(Patient-reported history: ${intake})` : complaint },
];

// Single-shot re-triage once the authoritative EHR record is retrieved (urgent cases).
export const REFINE_SYSTEM = `You are a clinical decision-support tool. The patient has already been triaged from their presentation; now their hospital record is available. Re-evaluate and reply ONLY with the conclusion block:
DECISION: <EMERGENCY | URGENT | PHARMACIST-LED | ROUTINE>
SEVERITY: <0-10 integer>
RED FLAGS: <those present, or "none identified">
CONDITION: <single most likely working diagnosis, plain words>
ICD-10: <best-guess code>
ROUTING: <where this goes and why>
SAFETY-NET: <what to watch for>

Reflect the record: account for anticoagulants/interactions (e.g. on an anticoagulant → bleeding precautions; raise concern for bleeding-related complaints), comorbidities that raise risk, and allergies (avoid contraindicated drugs). Do NOT downgrade urgency below the presentation; you may escalate or add precautions. Be concise.`;

export const refine = (complaint: string, intake: string, ehr: string): Msg[] => [
  { role: "system", content: REFINE_SYSTEM },
  { role: "user", content: `Presentation: ${complaint}\nPatient-reported: ${intake || "none"}\nHospital record: ${ehr}` },
];
