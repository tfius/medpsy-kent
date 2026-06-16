// Kiosk scenario bank — curated test fixtures spanning the use cases a community-pharmacy triage
// kiosk mesh must handle. Consumed by scripts/kiosk_matrix.mjs (deterministic acceptance test).
// Three surfaces: the autonomous safety-review gate, federated pharmacovigilance signals, and the
// edge-learning federation lifecycle. Data only — no model/network — so the matrix is repeatable.

// ───────────────────────────────────────────────────────────────────────────────────────────
// 1) SAFETY-GATE SCENARIOS — clinical breadth × the gate's decision tree.
// Each: the agent's (possibly wrong) conclusion + the supervisor's verdict + an optional peer
// second opinion, and what the gate MUST produce. `verdict:"GARBAGE"` simulates a reviewer that
// returns unparseable output (fails open). `reaskLeft` defaults to 1. Expectations: the final
// decision, whether the SUPERVISOR escalated, whether the gate bounced a follow-up question, and
// whether a peer opinion was attached. The gate may only ever RAISE acuity, never lower it.
// ───────────────────────────────────────────────────────────────────────────────────────────
const v = (decision, severity, missedRedFlags = "none", askInstead = "", rationale = "review") =>
  ({ agree: false, decision, severity, missedRedFlags, askInstead, rationale });
const agree = (decision, severity) => ({ agree: true, decision, severity, missedRedFlags: "none", askInstead: "", rationale: "appropriate" });
const peer = (answer, escalate, emergency = false) => ({ answer, peer: "Dr-Peer", signatureOk: true, escalate, emergency });

export const GATE_SCENARIOS = [
  // — under-triage caught across body systems (the worst failure mode) —
  { id: "acs-undertriage", category: "cardiac", lang: "en",
    complaint: "Crushing central chest pain 30 min, radiating to left arm and jaw, sweaty.",
    agent: { decision: "ROUTINE", severity: 2, condition: "muscle strain", icd: "M79.1", redFlags: "none identified", routing: "self-care", safetyNet: "return if worse" },
    verdict: v("EMERGENCY", 9, "possible ACS"), expect: { decision: "EMERGENCY", escalated: true } },
  { id: "stroke-undertriage", category: "neuro", lang: "en",
    complaint: "Sudden right-sided face droop and arm weakness 40 min ago.",
    agent: { decision: "PHARMACIST-LED", severity: 3, condition: "Bell's palsy", icd: "G51.0", redFlags: "none", routing: "pharmacist advice", safetyNet: "return if worse" },
    verdict: v("EMERGENCY", 9, "FAST-positive — possible stroke"), expect: { decision: "EMERGENCY", escalated: true } },
  { id: "dka-escalate", category: "endocrine", lang: "en",
    complaint: "Type-1 diabetic, very thirsty, vomiting, deep rapid breathing, drowsy.",
    agent: { decision: "URGENT", severity: 6, condition: "gastroenteritis", icd: "A09", redFlags: "vomiting", routing: "same-day GP", safetyNet: "return if worse" },
    verdict: v("EMERGENCY", 9, "possible DKA — Kussmaul breathing + drowsiness"), expect: { decision: "EMERGENCY", escalated: true } },
  { id: "cauda-equina", category: "neuro", lang: "en",
    complaint: "Back pain with numbness around the saddle area and new trouble passing urine.",
    agent: { decision: "ROUTINE", severity: 3, condition: "mechanical back pain", icd: "M54.5", redFlags: "none identified", routing: "self-care", safetyNet: "rest" },
    verdict: v("EMERGENCY", 9, "cauda equina red flags — saddle anaesthesia + retention"), expect: { decision: "EMERGENCY", escalated: true } },
  { id: "warfarin-nsaid", category: "interaction", lang: "en",
    complaint: "On warfarin, took ibuprofen for back pain, now black tarry stools.",
    agent: { decision: "ROUTINE", severity: 3, condition: "indigestion", icd: "K30", redFlags: "none", routing: "self-care", safetyNet: "return if worse" },
    verdict: v("URGENT", 6, "melaena on an anticoagulant — GI bleed"), expect: { decision: "URGENT", escalated: true } },

  // — off-enum / garbled supervisor labels must NOT silently drop an escalation —
  { id: "paeds-meningitis-offenum", category: "paediatric", lang: "en",
    complaint: "18-month-old, fever, non-blanching rash, very floppy.",
    agent: { decision: "ROUTINE", severity: 3, condition: "viral rash", icd: "B09", redFlags: "none identified", routing: "self-care", safetyNet: "fluids" },
    verdict: v("A&E", 8, "non-blanching rash — possible meningococcal"), expect: { decision: "EMERGENCY", escalated: true } },
  { id: "gi-bleed-refer", category: "gastro", lang: "en",
    complaint: "Vomiting bright red blood twice this morning.",
    agent: { decision: "PHARMACIST-LED", severity: 4, condition: "Mallory-Weiss", icd: "K22.6", redFlags: "haematemesis", routing: "pharmacist advice", safetyNet: "return" },
    verdict: v("refer urgently", 6, "active haematemesis"), expect: { decision: "URGENT", escalated: true } },
  { id: "garbled-conservative", category: "cardiac", lang: "en",
    complaint: "Odd fluttering in the chest, came and went.",
    agent: { decision: "ROUTINE", severity: 2, condition: "benign ectopics", icd: "R00.2", redFlags: "none", routing: "self-care", safetyNet: "return if worse" },
    verdict: v("???", 5, "uncharacterised arrhythmia — needs ECG"), expect: { decision: "URGENT", escalated: true } },

  // — appropriate conclusions are left ALONE (no over-escalation) —
  { id: "sepsis-agree", category: "infection", lang: "en",
    complaint: "Fever, rigors, confusion, fast breathing after a UTI.",
    agent: { decision: "URGENT", severity: 7, condition: "possible sepsis", icd: "A41.9", redFlags: "confusion + tachypnoea", routing: "same-day assessment", safetyNet: "999 if worse" },
    verdict: agree("URGENT", 7), expect: { decision: "URGENT", escalated: false } },
  { id: "urti-benign-agree", category: "self-care", lang: "en",
    complaint: "Mild sore throat and runny nose for a day, no fever.",
    agent: { decision: "PHARMACIST-LED", severity: 3, condition: "viral URTI", icd: "J06.9", redFlags: "none identified", routing: "pharmacist advice", safetyNet: "return if breathing difficulty" },
    verdict: agree("PHARMACIST-LED", 3), expect: { decision: "PHARMACIST-LED", escalated: false } },
  { id: "elderly-polypharmacy-agree", category: "geriatric", lang: "en",
    complaint: "82, on 9 medicines, mild constipation for a few days.",
    agent: { decision: "PHARMACIST-LED", severity: 3, condition: "constipation", icd: "K59.0", redFlags: "none", routing: "pharmacist advice", safetyNet: "return if pain/vomiting" },
    verdict: agree("PHARMACIST-LED", 3), expect: { decision: "PHARMACIST-LED", escalated: false } },
  { id: "multilingual-es", category: "cardiac", lang: "es",
    complaint: "Dolor de pecho opresivo que se irradia al brazo izquierdo, sudoración.",
    agent: { decision: "EMERGENCY", severity: 9, condition: "síndrome coronario agudo", icd: "I20.0", redFlags: "dolor torácico", routing: "112", safetyNet: "llame a emergencias" },
    verdict: agree("EMERGENCY", 9), expect: { decision: "EMERGENCY", escalated: false } },

  // — safety-bias: the gate can never LOWER acuity —
  { id: "anaphylaxis-no-deescalate", category: "allergy", lang: "en",
    complaint: "Lip and tongue swelling, wheeze, after a new antibiotic.",
    agent: { decision: "EMERGENCY", severity: 10, condition: "anaphylaxis", icd: "T78.2", redFlags: "airway compromise", routing: "999", safetyNet: "adrenaline now" },
    verdict: v("ROUTINE", 1, "looks mild"), expect: { decision: "EMERGENCY", escalated: false } },
  { id: "overtriage-not-corrected", category: "false-alarm", lang: "en",
    complaint: "Red urine — ate a lot of beetroot yesterday, no pain.",
    agent: { decision: "URGENT", severity: 6, condition: "haematuria", icd: "R31.9", redFlags: "red urine", routing: "same-day GP", safetyNet: "return" },
    verdict: v("ROUTINE", 2, "beeturia, not blood"),
    // DOCUMENTED asymmetry: the gate is safety-biased and will NOT de-escalate the agent's
    // over-triage. Stays URGENT. (Over-triage is corrected by the human reviewer, not the gate.)
    expect: { decision: "URGENT", escalated: false } },

  // — self-directed follow-up question (plausible-but-unconfirmed red flag) —
  { id: "suicidality-followup", category: "mental-health", lang: "en",
    complaint: "Feeling really low and hopeless for weeks.",
    agent: { decision: "ROUTINE", severity: 3, condition: "low mood", icd: "R45.2", redFlags: "none identified", routing: "self-care", safetyNet: "talk to someone" },
    verdict: v("URGENT", 6, "possible suicidality not screened", "Have you had any thoughts of harming yourself or ending your life?"),
    reaskLeft: 1, expect: { ask: true } },
  { id: "suicidality-budget-exhausted", category: "mental-health", lang: "en",
    complaint: "Feeling really low and hopeless for weeks.",
    agent: { decision: "ROUTINE", severity: 3, condition: "low mood", icd: "R45.2", redFlags: "none identified", routing: "self-care", safetyNet: "talk to someone" },
    verdict: v("URGENT", 6, "possible suicidality not screened", "Have you had any thoughts of harming yourself?"),
    reaskLeft: 0, expect: { decision: "URGENT", escalated: true } },

  // — autonomous peer consult when uncertain; peer may only RAISE —
  { id: "ectopic-peer-emergency", category: "obstetric", lang: "en",
    complaint: "Possibly pregnant, one-sided lower abdo pain and a little shoulder-tip pain.",
    agent: { decision: "INSUFFICIENT-DATA", severity: 5, condition: "abdominal pain, unclear", icd: "R10.3", redFlags: "none identified", routing: "pharmacist review", safetyNet: "return" },
    verdict: agree("INSUFFICIENT-DATA", 5), consult: peer("ESCALATE — shoulder-tip pain in a possible pregnancy is ectopic until excluded; call 999.", true, true),
    expect: { decision: "EMERGENCY", escalated: false, consult: true } },
  { id: "insufficient-peer-agrees", category: "gastro", lang: "en",
    complaint: "Vague tummy ache, comes and goes, otherwise well.",
    agent: { decision: "INSUFFICIENT-DATA", severity: 5, condition: "non-specific abdominal pain", icd: "R10.9", redFlags: "none identified", routing: "pharmacist review", safetyNet: "return" },
    verdict: agree("INSUFFICIENT-DATA", 5), consult: peer("AGREE — reasonable to have a pharmacist review; safety-net and review.", false),
    expect: { decision: "INSUFFICIENT-DATA", escalated: false, consult: true } },
  { id: "reviewer-error-peer-fires", category: "cardiac", lang: "en",
    // The reviewer FAILS (unparseable) → fails open, but the case is marked uncertain so the
    // peer-consult fallback STILL fires. A reviewer outage must not disable both safety layers.
    complaint: "Chest tightness on exertion, eases with rest.",
    agent: { decision: "ROUTINE", severity: 3, condition: "muscle ache", icd: "M79.1", redFlags: "none", routing: "self-care", safetyNet: "return" },
    verdict: "GARBAGE", consult: peer("ESCALATE — exertional chest tightness is angina until proven otherwise.", true),
    expect: { decision: "URGENT", escalated: false, consult: true } },
  { id: "escalate-then-peer-raises", category: "neuro", lang: "en",
    // Supervisor escalates ROUTINE→URGENT (no follow-up); the peer then raises further to EMERGENCY.
    complaint: "Worst headache of my life, came on in seconds.",
    agent: { decision: "ROUTINE", severity: 2, condition: "tension headache", icd: "R51", redFlags: "none identified", routing: "self-care", safetyNet: "return" },
    verdict: v("URGENT", 6, "thunderclap headache"), consult: peer("ESCALATE — thunderclap headache, call 999 for SAH workup.", true, true),
    expect: { decision: "EMERGENCY", escalated: true, consult: true } },
  { id: "peer-cannot-downgrade", category: "cardiac", lang: "en",
    // Supervisor escalates ROUTINE→EMERGENCY; a peer says "escalate" but only to URGENT-level —
    // the guard (ACUITY[target] > ACUITY[final]) must BLOCK the downgrade. Stays EMERGENCY.
    complaint: "Sudden crushing chest pain, clammy, feels like impending doom.",
    agent: { decision: "ROUTINE", severity: 2, condition: "anxiety", icd: "F41.9", redFlags: "none identified", routing: "self-care", safetyNet: "return" },
    verdict: v("EMERGENCY", 9, "ACS presentation"), consult: peer("ESCALATE — would arrange urgent review.", true, false),
    expect: { decision: "EMERGENCY", escalated: true, consult: true } },
];

// ───────────────────────────────────────────────────────────────────────────────────────────
// 2) SIGNAL SCENARIOS — federated pharmacovigilance threshold edge cases.
// `obs`: per-kiosk observations [kiosk, drugA, drugB, adverse, times]. `known`: pairs already an
// edge (excluded). `cross`: the pairs that MUST cross the threshold (≥2 kiosks · ≥3 flagged ·
// rate ≥0.3). `assertAgg` (optional): exact summed {seen,flagged,contributors} for one pair.
// ───────────────────────────────────────────────────────────────────────────────────────────
export const SIGNAL_SCENARIOS = [
  { id: "exact-at-threshold", obs: [["A", "x1", "y1", true, 2], ["B", "x1", "y1", true, 1], ["A", "x1", "y1", false, 3]],
    cross: [["x1", "y1"]] }, // 3 flagged / 6 seen across 2 kiosks, rate 0.5
  { id: "rate-exactly-0.3", obs: [["A", "x2", "y2", true, 2], ["B", "x2", "y2", true, 1], ["A", "x2", "y2", false, 7]],
    cross: [["x2", "y2"]] }, // 3 flagged / 10 seen, rate exactly 0.3 → crosses (>=)
  { id: "just-below-flagged", obs: [["A", "x3", "y3", true, 1], ["B", "x3", "y3", true, 1], ["A", "x3", "y3", false, 1]],
    cross: [] }, // only 2 flagged (< 3) → no
  { id: "single-kiosk-heavy", obs: [["A", "x4", "y4", true, 8]],
    cross: [] }, // 8 flagged but 1 kiosk (< 2 contributors) → no, NO MATTER how strong
  { id: "rate-below", obs: [["A", "x5", "y5", true, 2], ["B", "x5", "y5", true, 1], ["A", "x5", "y5", false, 27]],
    cross: [] }, // 3 flagged / 30 seen, rate 0.1 (< 0.3) → no
  { id: "distributed-3-kiosks", obs: [["A", "x6", "y6", true, 1], ["B", "x6", "y6", true, 1], ["C", "x6", "y6", true, 1]],
    cross: [["x6", "y6"]], assertAgg: { a: "x6", b: "y6", seen: 3, flagged: 3, contributors: 3 } },
  { id: "known-pair-excluded", obs: [["A", "x7", "y7", true, 2], ["B", "x7", "y7", true, 2]],
    known: [["x7", "y7"]], cross: [] }, // would cross, but already a known edge → excluded
  { id: "multi-pair-mixed", obs: [["A", "x8", "y8", true, 2], ["B", "x8", "y8", true, 2], ["A", "p8", "q8", true, 5]],
    cross: [["x8", "y8"]] }, // x8/y8 crosses (2 kiosks); p8/q8 is single-kiosk → no
  { id: "stale-version-dedup", obs: [["A", "x9", "y9", true, 3], ["Amirror", "x9", "y9", true, 3, "A"], ["B", "x9", "y9", true, 1]],
    // contributor "A"'s SAME tally (same statementId) appears in two logs — its own core AND a
    // peer's mirror of it (6th field pins the contributor). Must count A ONCE (dedup by
    // statementId), not twice: 2 contributors (A,B), 4 flagged (3+1), not 7.
    cross: [["x9", "y9"]], assertAgg: { a: "x9", b: "y9", seen: 4, flagged: 4, contributors: 2 } },
  { id: "order-independent", obs: [["A", "y0", "x0", true, 2], ["B", "x0", "y0", true, 1]],
    // logged in opposite drug order on the two kiosks — must tally the SAME pair bucket.
    cross: [["x0", "y0"]], assertAgg: { a: "x0", b: "y0", seen: 3, flagged: 3, contributors: 2 } },
];

// ───────────────────────────────────────────────────────────────────────────────────────────
// 3) FEDERATION lifecycle — real edge-learning functions across in-memory stores. (drugA, drugB
// are real names; the matrix drives proposeEdge/vetEdge-votes/promoteEdge/screenInteractions and
// a merge that mirrors the server's mergePeerGraph.) Plus a richer set of seed-able edges.
// ───────────────────────────────────────────────────────────────────────────────────────────
export const FED_EDGES = [
  { a: "fluconazole", b: "phenytoin", severity: "major", note: "CYP2C9 inhibition raises phenytoin" },
  { a: "amiodarone", b: "simvastatin", severity: "major", note: "CYP3A4 inhibition — myopathy" },
  { a: "clarithromycin", b: "ergotamine", severity: "major", note: "ergotism/vasospasm" },
  { a: "verapamil", b: "atenolol", severity: "major", note: "additive bradycardia/AV block" },
  { a: "phenelzine", b: "pseudoephedrine", severity: "major", note: "MAOI + sympathomimetic — hypertensive crisis" },
];
