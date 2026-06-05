// Pharmacist triage (provider-agnostic). Sends the structured triage prompt + the
// patient complaint to the LLM (medpsy) via whatever backend is configured.
import { TRIAGE_SYSTEM } from "./prompt.js";

export async function triage(provider, complaint) {
  const history = [
    { role: "system", content: TRIAGE_SYSTEM },
    { role: "user", content: complaint },
  ];
  return provider.complete(history);
}
