// The "senior clinician station": serve P2P second opinions for a consult code, answered by
// THIS device's own medpsy with a senior-clinician prompt. Run it on a second device (or a
// second process), then start the kiosk with the SAME code (MEDPSY_CONSULT_CODE=<code>) — the
// kiosk's agent gets a consult_peer tool that reaches this station. No cloud.
//   MEDPSY_BACKEND=qvac node scripts/consult_responder.mjs CLINIC-01
import { getProvider } from "../src/backend.js";
import { serveConsult } from "../src/consult.js";
import { vetEdge } from "../src/edge-learning.js";

const code = process.argv[2] || process.env.MEDPSY_CONSULT_CODE || "CLINIC-01";
const provider = await getProvider();
await provider.init();

const SYS = "You are a SENIOR clinician giving a brief SECOND OPINION to a community pharmacist's triage assistant. Be concise (2–4 sentences): name the key red flags, the safest disposition (emergency / urgent / pharmacist-led / routine), and anything you'd add or change. You are advisory; the on-site pharmacist decides.";

const { device } = await serveConsult(
  code,
  async (question, context) => {
    const user = context ? `${question}\n\nContext: ${context}` : question;
    const history = [{ role: "system", content: SYS }, { role: "user", content: user }];
    const answer = (await provider.complete(history, { temperature: 0.3 })).trim();
    console.log(`[consult] Q: ${question.slice(0, 80)}\n[consult] A: ${answer.slice(0, 120)}…\n`);
    return answer;
  },
  // Peer-network vetting: this station adversarially vets proposed interaction edges with its
  // OWN medpsy — an independent vote in the edge-learning loop.
  { vetFn: async (edge) => {
      const v = await vetEdge(provider, edge);
      console.log(`[vet] ${edge.a} + ${edge.b} → ${v.real ? "REAL" : "REFUTED"} (${v.severity}) — ${v.reason}`);
      return v;
    } },
);

console.log(`[consult-responder] ${device.name} (${provider.name}) serving code "${code}" — second opinions + edge vetting. Ctrl-C to stop.`);
