// Pharmacist-training sandbox — a teaching layer that REUSES the agentic triage + safety gate as
// an answer key. A trainee reads a simulated case, commits to a disposition, then sees: their call
// graded against a clinician-authored expected answer (under-triage is the failure that matters),
// the AI's independent assessment, and the safety-review critique. Training runs never touch the
// real record (server skips KB/signals/facts when `training:true`).
import { runTriageTurn, type TriageOutcome, type ATriageEvent } from "./atriage";

export type Band = "RED" | "AMBER" | "GREEN";
export type Disposition = "EMERGENCY" | "URGENT" | "PHARMACIST-LED" | "ROUTINE";
export interface TrainingCase {
  id: string; title: string; category: string;
  narrative: string;                 // the full simulated case shown to the trainee + sent to the AI
  expected: Disposition;             // the clinician-authored correct disposition
  redFlags: string;                  // what a safe triage must catch (or "none")
  teaching: string;                  // the one-line lesson revealed after answering
}

// Acuity ordering — under-triage (picking BELOW expected) is the dangerous error; over-triage is
// merely cautious. Kept in sync with the server's gate (src/triage-agent.js ACUITY).
export const ACUITY: Record<Disposition, number> = { ROUTINE: 0, "PHARMACIST-LED": 1, URGENT: 2, EMERGENCY: 3 };
export const bandOf = (d: Disposition): Band => (d === "EMERGENCY" ? "RED" : d === "URGENT" ? "AMBER" : "GREEN");

export type Grade = { verdict: "correct" | "under" | "over"; label: string; safe: boolean };
export function grade(pick: Disposition, expected: Disposition): Grade {
  if (pick === expected) return { verdict: "correct", label: "Correct disposition", safe: true };
  if (ACUITY[pick] < ACUITY[expected]) return { verdict: "under", label: "UNDER-TRIAGED — this is the dangerous error", safe: false };
  return { verdict: "over", label: "Over-cautious — safe, but would over-refer", safe: true };
}

// Curated teaching cases — emergencies, benign self-care, and the traps that teach over/under-triage.
export const TRAINING_CASES: TrainingCase[] = [
  { id: "acs", title: "Chest pain in a 58-year-old", category: "cardiac",
    narrative: "A 58-year-old man describes 40 minutes of heavy central chest pressure spreading into his left arm and jaw, with sweating and nausea. He has high blood pressure and smokes. It hasn't eased with rest.",
    expected: "EMERGENCY", redFlags: "Crushing radiating chest pain + diaphoresis = acute coronary syndrome until proven otherwise.", teaching: "Classic ACS — call 999 immediately; do not delay for more questions." },
  { id: "beeturia", title: "Red urine after a salad", category: "false-alarm",
    narrative: "A well 30-year-old is alarmed that her urine looked pink-red this morning. No pain, no fever, no urinary symptoms. She ate a large beetroot salad last night and feels completely fine.",
    expected: "PHARMACIST-LED", redFlags: "none — painless red urine with a clear beetroot history is likely beeturia.", teaching: "A scary-looking sign with a benign cause — reassure + safety-net, don't reflexively escalate (over-triage wastes ED capacity)." },
  { id: "meningitis", title: "Feverish toddler with a rash", category: "paediatric",
    narrative: "An 18-month-old has had a fever since last night and is now floppy and not feeding. The parent noticed a few dark red spots on the legs that do not fade when pressed with a glass.",
    expected: "EMERGENCY", redFlags: "Non-blanching rash + lethargy + fever in a child = possible meningococcal sepsis.", teaching: "Non-blanching rash in an unwell child is a 999 emergency — never 'watch and wait'." },
  { id: "sore-throat", title: "Mild sore throat", category: "self-care",
    narrative: "A healthy 25-year-old has had a mildly sore throat and a runny nose for a day. No difficulty breathing or swallowing, no fever, no drooling, voice normal.",
    expected: "PHARMACIST-LED", redFlags: "none identified.", teaching: "Uncomplicated viral URTI — pharmacist advice + safety-net for breathing/swallowing difficulty." },
  { id: "cauda-equina", title: "Back pain with new numbness", category: "neuro",
    narrative: "A 45-year-old with a week of low back pain now reports numbness around the buttocks/saddle area and difficulty starting to urinate since this morning.",
    expected: "EMERGENCY", redFlags: "Saddle anaesthesia + urinary retention = cauda equina syndrome — a surgical emergency.", teaching: "Back pain is usually benign, but saddle anaesthesia + retention is a same-hour emergency referral." },
  { id: "warfarin-bleed", title: "Tarry stools on warfarin", category: "interaction",
    narrative: "A 70-year-old on warfarin took ibuprofen for a few days for knee pain and now reports two episodes of black, tarry, foul-smelling stools and feeling lightheaded.",
    expected: "EMERGENCY", redFlags: "Melaena on an anticoagulant (+ NSAID) = GI bleed; lightheadedness suggests volume loss.", teaching: "Melaena on warfarin is an emergency — the NSAID interaction is the avoidable cause." },
  { id: "ectopic", title: "One-sided pain, possibly pregnant", category: "obstetric",
    narrative: "A 28-year-old with a late period and a possible pregnancy has one-sided lower abdominal pain and some light shoulder-tip discomfort. She looks pale.",
    expected: "EMERGENCY", redFlags: "Shoulder-tip pain + one-sided pain in possible pregnancy = ectopic until excluded.", teaching: "Shoulder-tip pain in a possible pregnancy points to ectopic — urgent same-hour assessment." },
  { id: "low-mood", title: "Low mood, came in for a sleep aid", category: "mental-health",
    narrative: "A 35-year-old says they've felt low, hopeless, and not sleeping for several weeks, with little interest in things they used to enjoy. They came in asking for a strong sleep aid, and when gently asked, admit they've had fleeting thoughts that life isn't worth living, though no plan.",
    expected: "URGENT", redFlags: "Disclosed passive suicidal ideation on a backdrop of depression — needs same-day mental-health assessment, not a sleep aid.", teaching: "The buying request (a sleep aid) masks the real risk — screening surfaced passive suicidal ideation, which makes this same-day URGENT. The safety gate insists on exactly this screen." },
];

const CONCLUDE_DIRECTIVE = "\n\n(This is a complete case summary for assessment — give your triage conclusion now based on the information provided.)";

// Run the AI's independent assessment of a case in TRAINING mode (no real-record writes). Returns
// the structured outcome (with the safety-review `supervised` block) or a question/aborted note.
export async function runAiAssessment(
  narrative: string,
  onEvent: (e: ATriageEvent) => void,
  signal?: AbortSignal,
): Promise<{ outcome?: TriageOutcome; question?: string }> {
  let outcome: TriageOutcome | undefined; let question: string | undefined;
  const encounterId = `train-${Date.now()}`;
  await runTriageTurn(narrative + CONCLUDE_DIRECTIVE, (e) => {
    if (e.type === "conclusion") outcome = e.outcome;
    else if (e.type === "question") question = e.text;
    onEvent(e);
  }, { training: true, reset: true, encounterId, signal });
  return { outcome, question };
}
