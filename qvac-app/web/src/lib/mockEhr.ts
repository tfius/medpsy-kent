// Mock hospital record — stands in for the FHIR fetch (architecture step 6). The
// default record carries an anticoagulant + allergy + prior MI so re-triage visibly
// adds precautions / can escalate. Keyed loosely by patient name for the demo.
export type EhrRecord = { meds: string[]; conditions: string[]; allergies: string[] };

const RECORDS: Record<string, EhrRecord> = {
  default: {
    meds: ["warfarin 5mg daily (anticoagulant)", "ramipril 5mg", "metformin 1g BD"],
    conditions: ["atrial fibrillation", "type 2 diabetes", "previous myocardial infarction (2024)"],
    allergies: ["penicillin (anaphylaxis)"],
  },
  jane: {
    meds: ["apixaban 5mg BD (anticoagulant)", "naproxen PRN"],
    conditions: ["DVT (2025)", "osteoarthritis"],
    allergies: ["none recorded"],
  },
};

export function getMockEhr(name?: string): EhrRecord {
  return RECORDS[(name || "").trim().toLowerCase()] || RECORDS.default;
}

export function ehrText(r: EhrRecord): string {
  return `Medications: ${r.meds.join(", ")}. Conditions: ${r.conditions.join(", ")}. Allergies: ${r.allergies.join(", ")}.`;
}
