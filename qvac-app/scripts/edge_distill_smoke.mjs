// Auto-distillation smoke — medpsy reads a clinician correction and PROPOSES the missed
// interaction edge itself (no human in the propose step). Closes the autonomous loop.
//   MEDPSY_BACKEND=qvac node scripts/edge_distill_smoke.mjs
import { getProvider } from "../src/backend.js";
import { distillEdges } from "../src/edge-learning.js";

const correction = "I overrode the triage: the patient is on warfarin and was prescribed oral miconazole gel. Miconazole strongly inhibits CYP2C9/CYP3A4, markedly raising warfarin levels/INR and bleeding risk — a MAJOR interaction the assistant missed.";

const provider = await getProvider();
await provider.init();
console.log("distilling from a clinician correction…");
const { edges } = await distillEdges(provider, { meds: ["warfarin"], correction });
console.log("distilled edges:", JSON.stringify(edges));

const hit = edges.some((e) => {
  const s = `${e.a} ${e.b}`.toLowerCase();
  return s.includes("warfarin") && s.includes("miconazole");
});
console.log(`\n${hit ? "PASS" : "FAIL"} — medpsy auto-proposed the warfarin+miconazole edge from the correction`);
await provider.close?.();
process.exit(hit ? 0 : 1);
