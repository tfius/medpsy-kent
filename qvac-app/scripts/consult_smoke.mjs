// P2P consult smoke — a responder serves second opinions for a code; a requester consults it
// over the real hyperswarm DHT and verifies the SIGNED answer round-trips. Uses a stub
// answerFn (no model load); the real responder runs medpsy (scripts/consult_responder.mjs).
//   node scripts/consult_smoke.mjs
import { serveConsult, consult } from "../src/consult.js";

const CODE = "SMOKE-CONSULT-01";
const responder = await serveConsult(CODE, async (q) => {
  console.log(`[responder] got: "${q}"`);
  return `Second opinion: for "${q.slice(0, 40)}…", escalate if red flags; otherwise pharmacist-led with safety-net.`;
});
console.log(`[responder] serving code ${CODE} as ${responder.device.name}`);

console.log(`[requester] consulting over the DHT (~5–15 s)…`);
let ok = false;
try {
  const r = await consult(CODE, "62yo diabetic, atypical fatigue + jaw ache, no chest pain — emergency?", { timeoutMs: 30000 });
  console.log(`[requester] answer: ${r.answer.slice(0, 90)}…`);
  console.log(`[requester] from peer: ${r.peer?.name} (${r.peer?.publicKey?.slice(0, 12)}…) · signature ${r.signatureOk ? "valid ✓" : "INVALID ✗"}`);
  ok = !!r.answer && r.signatureOk;
} catch (e) { console.log(`[requester] failed: ${e?.message || e}`); }

console.log(`\n${ok ? "PASS" : "FAIL"} — signed second opinion ${ok ? "received + verified" : "not received/verified"}`);
await responder.swarm.destroy().catch(() => {});
process.exit(ok ? 0 : 1);
