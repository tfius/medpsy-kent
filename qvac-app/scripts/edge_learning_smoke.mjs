// Edge-learning lifecycle smoke — proves the privacy-preserving knowledge loop end to end,
// on-device: a CANDIDATE interaction edge does NOT ground the agent; medpsy adversarially
// VETS it; once PROMOTED it grounds (the agent now catches the interaction). The "learning"
// half of the federated loop — replication (kb_swarm_smoke) carries it between kiosks.
//   MEDPSY_BACKEND=qvac node scripts/edge_learning_smoke.mjs
import { createFactStore, MemoryAdapter } from "@qvac/factstore";
import { seedInteractions, screenInteractions, drugId } from "../src/medlens.js";
import { proposeEdge, vetEdge, promoteEdge } from "../src/edge-learning.js";
import { getProvider } from "../src/backend.js";

const A = "warfarin", B = "fluconazole"; // a REAL major interaction NOT in the seed graph
const kb = createFactStore({ adapter: new MemoryAdapter() });
await seedInteractions(kb);
const patient = createFactStore({ adapter: new MemoryAdapter() });
await patient.assert("patient:test", { subject: "patient:test", predicate: "takes", object: { ref: drugId(A) }, source: "intake" });

const screen = async () => (await screenInteractions(patient, { patientLog: "patient:test", candidate: B, kbStore: kb })).length;

const before = await screen();
console.log(`1) screen ${A}+${B} before learning: ${before} interaction(s)`);

await proposeEdge(kb, { a: A, b: B, severity: "major", note: "fluconazole inhibits CYP2C9 → raised INR/bleeding", contributedBy: "kioskA", evidence: "enc-abc123" });
const afterPropose = await screen();
console.log(`2) proposed candidate edge → screen: ${afterPropose} (should still be 0 — candidates don't ground)`);

console.log(`3) adversarial vet by medpsy (loading model…)`);
const provider = await getProvider();
await provider.init();
const verdict = await vetEdge(provider, { a: drugId(A), b: drugId(B), severity: "major", note: "CYP2C9 inhibition" });
console.log(`   verdict: real=${verdict.real} severity=${verdict.severity} — ${verdict.reason}`);

if (verdict.real) await promoteEdge(kb, `lx:${drugId(A)}>${drugId(B)}`, { by: "vet:medpsy", severity: verdict.severity });
const afterPromote = await screen();
console.log(`4) after promotion → screen: ${afterPromote} interaction(s) (should be 1 — now grounded)`);

const ok = before === 0 && afterPropose === 0 && verdict.real === true && afterPromote === 1;
console.log(`\n${ok ? "PASS" : "FAIL"} — candidate ignored (${afterPropose === 0}), vetted (${verdict.real}), promoted-grounds (${afterPromote === 1})`);
await provider.close?.();
process.exit(ok ? 0 : 1);
