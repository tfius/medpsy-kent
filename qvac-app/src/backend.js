// Provider factory. MEDPSY_BACKEND=lmstudio (default, dev) | qvac (local-first SDK).
// Both expose the same interface: init(), complete(history,opts)->string,
// embed(texts)->number[][], close(). So triage + ICD-RAG code is backend-agnostic.
import { BACKEND } from "./config.js";
import { makeLmStudioProvider } from "./backends/lmstudio.js";

export async function getProvider() {
  if (BACKEND === "qvac") {
    const { makeQvacProvider } = await import("./backends/qvac.js");
    return makeQvacProvider();
  }
  return makeLmStudioProvider();
}
