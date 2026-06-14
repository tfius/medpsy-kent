// The whole loop, end to end: kiosk A learns + promotes an interaction edge; it replicates to
// kiosk B; B's agent now grounds on it — while a still-CANDIDATE edge never crosses into
// grounding on B (the safety property holds across devices). Direct streams (offline/CI).
//   node scripts/edge_federation_smoke.mjs
import os from "node:os"; import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { createFactStore, MemoryAdapter } from "@qvac/factstore";
import { HypercoreAdapter } from "@qvac/factstore/hypercore";
import { seedInteractions, screenInteractions, drugId } from "../src/medlens.js";
import { proposeEdge, promoteEdge } from "../src/edge-learning.js";
import { waitForLength } from "../src/kb-sync.js";

const tmp = (n) => { const d = path.join(os.tmpdir(), `edgefed-${n}-${crypto.randomBytes(4).toString("hex")}`); fs.mkdirSync(d, { recursive: true }); return d; };
const A = "warfarin", B = "fluconazole";

// Kiosk A — the contributor. Seed + propose a candidate.
const aAdapter = new HypercoreAdapter({ storage: tmp("A") });
const aKb = createFactStore({ adapter: aAdapter });
await seedInteractions(aKb);
await proposeEdge(aKb, { a: A, b: B, severity: "major", note: "CYP2C9", contributedBy: "kioskA" });
const aCore = aAdapter.cores.get("kb:medical");
console.log(`[A] seeded + proposed candidate; core length ${aCore.length}`);

// Kiosk B — replicates A's graph; a patient on warfarin.
const bAdapter = new HypercoreAdapter({ storage: tmp("B") });
const bKb = createFactStore({ adapter: bAdapter });
const bRemote = await bAdapter.addRemoteCore("kb:medical", await aAdapter.coreKey("kb:medical"));
const patient = createFactStore({ adapter: new MemoryAdapter() });
await patient.assert("p", { subject: "p", predicate: "takes", object: { ref: drugId(A) }, source: "intake" });
const screenB = async () => (await screenInteractions(patient, { patientLog: "p", candidate: B, kbStore: bKb })).length;

const as = aAdapter.replicate(true), bs = bAdapter.replicate(false);
as.on("error", () => {}); bs.on("error", () => {});
as.pipe(bs).pipe(as);
await waitForLength(bRemote, aCore.length);
const whileCandidate = await screenB();
console.log(`[B] after replicating the CANDIDATE: screen ${A}+${B} = ${whileCandidate} (must be 0 — candidates never ground)`);

// A promotes the edge → replicates → B should now ground on it.
const beforePromote = aCore.length;
await promoteEdge(aKb, `lx:${drugId(A)}>${drugId(B)}`, { by: "vet:medpsy", severity: "major" });
await waitForLength(bRemote, beforePromote + 1);
const afterPromote = await screenB();
console.log(`[B] after A PROMOTED it: screen ${A}+${B} = ${afterPromote} (must be 1 — now grounded from a peer)`);

const ok = whileCandidate === 0 && afterPromote === 1;
console.log(`\n${ok ? "PASS" : "FAIL"} — candidate stayed un-grounded across devices (${whileCandidate === 0}); promoted edge federated + grounded on the peer (${afterPromote === 1})`);
await aAdapter.close(); await bAdapter.close();
process.exit(ok ? 0 : 1);
