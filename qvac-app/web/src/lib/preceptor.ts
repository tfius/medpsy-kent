// Triage Preceptor — a clinical-education layer that reuses the real triage agent + its
// independent safety review as the "supervising clinician". Three workflows: INTERVIEW (you
// question a simulated patient, then decide — the skill that matters), QUICK (assess a full
// vignette), and BRING A CASE (a real/hypothetical case → the preceptor's grounded second
// opinion). Everything runs in training mode: nothing touches the record, KB, signals, or audit.
import { runTriageTurn, type TriageOutcome, type ATriageEvent } from "./atriage";

export type Band = "RED" | "AMBER" | "GREEN";
export type Disposition = "EMERGENCY" | "URGENT" | "PHARMACIST-LED" | "ROUTINE";
export interface ScreenDomain { label: string; keywords: string[] } // a red-flag area the trainee should probe
export interface TrainingCase {
  id: string; title: string; category: string;
  opening: string;                   // the patient's first line (interview mode)
  narrative: string;                 // the full vignette (quick mode + the AI's ground-truth read + patient brief)
  mustScreen: ScreenDomain[];        // the red-flag domains a safe interview must cover
  expected: Disposition;             // clinician-authored correct disposition
  redFlags: string; teaching: string;
}

// Acuity ordering — picking BELOW expected = under-triage = the dangerous error (kept in sync with
// the server gate, src/triage-agent.js ACUITY).
export const ACUITY: Record<Disposition, number> = { ROUTINE: 0, "PHARMACIST-LED": 1, URGENT: 2, EMERGENCY: 3 };
export const bandOf = (d: Disposition): Band => (d === "EMERGENCY" ? "RED" : d === "URGENT" ? "AMBER" : "GREEN");

export type Grade = { verdict: "correct" | "under" | "over"; label: string; safe: boolean };
export function grade(pick: Disposition, expected: Disposition): Grade {
  if (pick === expected) return { verdict: "correct", label: "Correct disposition", safe: true };
  if (ACUITY[pick] < ACUITY[expected]) return { verdict: "under", label: "UNDER-TRIAGED — the dangerous error", safe: false };
  return { verdict: "over", label: "Over-cautious — safe, but would over-refer", safe: true };
}

// Which red-flag domains did the trainee actually probe? Keyword match over everything they asked.
export function screeningCoverage(questions: string[], mustScreen: ScreenDomain[]) {
  const hay = questions.join(" \n ").toLowerCase();
  return mustScreen.map((d) => ({ label: d.label, asked: d.keywords.some((k) => hay.includes(k.toLowerCase())) }));
}

export const TRAINING_CASES: TrainingCase[] = [
  { id: "acs", title: "Chest pain, 58", category: "cardiac",
    opening: "I've got this heavy pressure in my chest and I just feel awful.",
    narrative: "A 58-year-old man: 40 minutes of heavy central chest pressure radiating to the left arm and jaw, with sweating and nausea, not eased by rest. History of high blood pressure; smoker.",
    mustScreen: [{ label: "radiation (arm/jaw)", keywords: ["arm", "jaw", "radiat", "spread", "shoulder"] }, { label: "sweating/nausea", keywords: ["sweat", "clammy", "nausea", "sick"] }, { label: "onset/duration", keywords: ["when", "how long", "start", "duration", "began"] }, { label: "exertion/rest", keywords: ["rest", "exert", "walking", "activity", "doing"] }],
    expected: "EMERGENCY", redFlags: "Crushing radiating chest pain + diaphoresis = ACS until proven otherwise.", teaching: "Classic ACS — call 999 immediately; do not delay for more questions once the picture is clear." },
  { id: "beeturia", title: "Red urine", category: "false-alarm",
    opening: "My wee looked pink-red this morning and it's really freaking me out.",
    narrative: "A well 30-year-old: painless pink-red urine this morning, no fever, no urinary symptoms, feels completely fine. Ate a large beetroot salad last night.",
    mustScreen: [{ label: "pain/dysuria", keywords: ["pain", "burning", "sting", "hurt", "dysuria"] }, { label: "diet (beetroot)", keywords: ["eat", "diet", "beet", "ate", "meal"] }, { label: "trauma", keywords: ["injur", "trauma", "hit", "fall"] }, { label: "fever/systemic", keywords: ["fever", "temperature", "unwell", "flank"] }],
    expected: "PHARMACIST-LED", redFlags: "none — painless red urine with a clear beetroot history is likely beeturia.", teaching: "A scary sign with a benign cause — reassure + safety-net; reflexive escalation here is over-triage." },
  { id: "meningitis", title: "Feverish toddler", category: "paediatric",
    opening: "My little one's had a fever since last night and now she's gone all floppy.",
    narrative: "An 18-month-old: fever since last night, now floppy and not feeding, with a few dark red spots on the legs that do NOT fade when pressed with a glass.",
    mustScreen: [{ label: "non-blanching rash", keywords: ["rash", "spots", "blanch", "glass", "fade", "marks"] }, { label: "alertness/feeding", keywords: ["floppy", "alert", "feed", "drink", "responsive", "drowsy"] }, { label: "neck/light", keywords: ["neck", "stiff", "light", "photophob"] }, { label: "breathing", keywords: ["breath", "breathing", "fast"] }],
    expected: "EMERGENCY", redFlags: "Non-blanching rash + lethargy + fever in a child = possible meningococcal sepsis.", teaching: "Non-blanching rash in an unwell child is a 999 emergency — never 'watch and wait'." },
  { id: "sore-throat", title: "Sore throat", category: "self-care",
    opening: "My throat's been a bit sore and my nose is running.",
    narrative: "A healthy 25-year-old: mildly sore throat and runny nose for a day. No difficulty breathing or swallowing, no drooling, no fever, voice normal.",
    mustScreen: [{ label: "breathing/swallowing", keywords: ["breath", "swallow", "drool", "saliva"] }, { label: "fever", keywords: ["fever", "temperature", "hot"] }, { label: "duration", keywords: ["how long", "when", "days", "started"] }, { label: "voice/neck", keywords: ["voice", "muffl", "neck", "swelling"] }],
    expected: "PHARMACIST-LED", redFlags: "none identified.", teaching: "Uncomplicated viral URTI — pharmacist advice + safety-net for breathing/swallowing difficulty." },
  { id: "cauda-equina", title: "Back pain + numbness", category: "neuro",
    opening: "My back's been killing me for about a week.",
    narrative: "A 45-year-old: a week of low back pain, now with numbness around the buttocks/saddle area and difficulty starting to urinate since this morning.",
    mustScreen: [{ label: "saddle anaesthesia", keywords: ["numb", "saddle", "buttock", "groin", "sensation"] }, { label: "bladder/bowel", keywords: ["urin", "wee", "bladder", "bowel", "incontinen", "retention"] }, { label: "leg weakness", keywords: ["weak", "legs", "walking", "power"] }, { label: "onset", keywords: ["when", "how long", "started", "sudden"] }],
    expected: "EMERGENCY", redFlags: "Saddle anaesthesia + urinary retention = cauda equina — a surgical emergency.", teaching: "Back pain is usually benign, but saddle anaesthesia + retention is a same-hour emergency referral." },
  { id: "warfarin-bleed", title: "Dark stools on warfarin", category: "interaction",
    opening: "I've been having some weird dark stools and I feel a bit dizzy.",
    narrative: "A 70-year-old on warfarin took ibuprofen for a few days for knee pain; now two episodes of black, tarry, foul-smelling stools and feeling lightheaded.",
    mustScreen: [{ label: "melaena/blood", keywords: ["black", "tarry", "blood", "stool", "colour"] }, { label: "anticoagulant", keywords: ["warfarin", "blood thinner", "blood-thinning", "anticoag"] }, { label: "NSAID use", keywords: ["ibuprofen", "nsaid", "painkiller", "anti-inflam", "nurofen"] }, { label: "dizziness/volume", keywords: ["dizzy", "lighthead", "faint", "pale"] }],
    expected: "EMERGENCY", redFlags: "Melaena on an anticoagulant (+NSAID) = GI bleed; lightheadedness suggests volume loss.", teaching: "Melaena on warfarin is an emergency — and the NSAID interaction is the avoidable cause." },
  { id: "ectopic", title: "One-sided pain, ?pregnant", category: "obstetric",
    opening: "I've got this pain low down on one side of my tummy.",
    narrative: "A 28-year-old with a late period and a possible pregnancy: one-sided lower abdominal pain and some light shoulder-tip discomfort, looking pale.",
    mustScreen: [{ label: "pregnancy/LMP", keywords: ["pregnan", "period", "lmp", "last period", "test"] }, { label: "shoulder-tip pain", keywords: ["shoulder", "tip"] }, { label: "bleeding", keywords: ["bleed", "spotting", "discharge"] }, { label: "dizziness/pallor", keywords: ["dizzy", "faint", "pale", "lighthead"] }],
    expected: "EMERGENCY", redFlags: "Shoulder-tip + one-sided pain in possible pregnancy = ectopic until excluded.", teaching: "Shoulder-tip pain in a possible pregnancy points to ectopic — urgent same-hour assessment." },
  { id: "low-mood", title: "Low mood, wants a sleep aid", category: "mental-health",
    opening: "I was after something strong to help me sleep.",
    narrative: "A 35-year-old: low, hopeless and not sleeping for several weeks, little interest in things they used to enjoy, here for a sleep aid. On screening, admits fleeting thoughts that life isn't worth living, though no plan.",
    mustScreen: [{ label: "mood/duration", keywords: ["mood", "low", "hopeless", "down", "how long", "weeks"] }, { label: "suicidal ideation", keywords: ["harm", "suicid", "end", "life", "worth living", "thoughts of"] }, { label: "function/anhedonia", keywords: ["interest", "enjoy", "appetite", "anhedonia", "pleasure"] }, { label: "support/plan", keywords: ["support", "alone", "plan", "help", "family"] }],
    expected: "URGENT", redFlags: "Passive suicidal ideation on a backdrop of depression — same-day mental-health assessment, not a sleep aid.", teaching: "The buying request masks the real risk — screening surfaced passive suicidal ideation, making this same-day URGENT. The safety gate insists on exactly this screen." },
];

// Patient simulator — the model role-plays the patient from the case's hidden brief (the full
// narrative). Backend-agnostic; the server writes nothing. `turns`: user = pharmacist, assistant = patient.
export async function askPatient(brief: string, turns: { role: "user" | "assistant"; content: string }[], question: string): Promise<string> {
  try {
    const r = await fetch("/api/patient-sim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief, turns, question }),
    });
    const j = await r.json().catch(() => null);
    return j?.reply || (j?.error ? `(patient unavailable: ${j.error})` : "(no response)");
  } catch (e) { return `(patient unavailable: ${e instanceof Error ? e.message : String(e)})`; }
}

const CONCLUDE_DIRECTIVE = "\n\n(This is a complete case summary for assessment — give your triage conclusion now based on the information provided.)";

// The preceptor's own read — runs the real triage agent + safety review in TRAINING mode (no
// record writes). Returns the structured outcome (with the `supervised` safety-review block).
export async function runAiAssessment(
  caseText: string,
  onEvent: (e: ATriageEvent) => void,
  signal?: AbortSignal,
): Promise<{ outcome?: TriageOutcome; question?: string }> {
  let outcome: TriageOutcome | undefined; let question: string | undefined;
  const encounterId = `train-${Date.now()}`;
  await runTriageTurn(caseText + CONCLUDE_DIRECTIVE, (e) => {
    if (e.type === "conclusion") outcome = e.outcome;
    else if (e.type === "question") question = e.text;
    onEvent(e);
  }, { training: true, reset: true, encounterId, signal });
  return { outcome, question };
}
