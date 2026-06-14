// Persistent consult-client smoke — a warm client joins once and reuses connections: the
// FIRST consult pays DHT discovery, the SECOND is fast. Also verifies askVetAll over it.
//   node scripts/consult_client_smoke.mjs
import { serveConsult, createConsultClient } from "../src/consult.js";

const CODE = "SMOKE-CLIENT-01";
const responder = await serveConsult(CODE, async (q) => `answer to: ${q.slice(0, 30)}`, {
  vetFn: async () => ({ real: true, severity: "major", reason: "stub vet" }),
});
console.log(`[responder] up as ${responder.device.name}`);

const client = createConsultClient(CODE);
const t0 = Date.now(); const r1 = await client.ask("first question");           const d1 = Date.now() - t0;
const t1 = Date.now(); const r2 = await client.ask("second question");          const d2 = Date.now() - t1;
const votes = await client.askVetAll({ a: "drug:warfarin", b: "drug:fluconazole", severity: "major", note: "x" });

console.log(`[client] ask1: "${r1.answer}" (${d1} ms, sig ${r1.signatureOk})`);
console.log(`[client] ask2: "${r2.answer}" (${d2} ms — warm) `);
console.log(`[client] askVetAll: ${votes.length} vote(s), real=${votes[0]?.verdict.real} sig=${votes[0]?.signatureOk}`);

const ok = !!r1.answer && !!r2.answer && d2 < d1 && votes.length >= 1 && votes[0].signatureOk;
console.log(`\n${ok ? "PASS" : "FAIL"} — warm client (2nd consult ${d2}<${d1} ms) + jury vet over a reused connection`);
await client.close(); await responder.swarm.destroy().catch(() => {});
process.exit(ok ? 0 : 1);
