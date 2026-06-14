// Peer-network vetting smoke — a responder vets a proposed interaction edge with its own
// (here stubbed) judgment; a requester asks it over the real DHT and verifies the SIGNED
// structured verdict. The real responder uses medpsy (scripts/consult_responder.mjs vetFn).
//   node scripts/consult_vet_smoke.mjs
import { serveConsult, consultVet } from "../src/consult.js";

const CODE = "SMOKE-VET-01";
const responder = await serveConsult(CODE, async () => "n/a", {
  vetFn: async (edge) => { console.log(`[responder] vetting ${edge.a} + ${edge.b}`); return { real: true, severity: "major", reason: "stub: CYP inhibition, clinically significant" }; },
});
console.log(`[responder] serving vet for ${CODE} as ${responder.device.name}`);

console.log(`[requester] consultVet over the DHT (~5–15 s)…`);
let ok = false;
try {
  const r = await consultVet(CODE, { a: "drug:warfarin", b: "drug:fluconazole", severity: "major", note: "CYP2C9" }, { timeoutMs: 30000 });
  console.log(`[requester] verdict: real=${r.verdict.real} severity=${r.verdict.severity} — ${r.verdict.reason}`);
  console.log(`[requester] from ${r.peer?.name} · signature ${r.signatureOk ? "valid ✓" : "INVALID ✗"}`);
  ok = r.verdict.real === true && r.signatureOk === true;
} catch (e) { console.log(`[requester] failed: ${e?.message || e}`); }

console.log(`\n${ok ? "PASS" : "FAIL"} — signed structured peer verdict ${ok ? "received + verified" : "not received/verified"}`);
await responder.swarm.destroy().catch(() => {});
process.exit(ok ? 0 : 1);
