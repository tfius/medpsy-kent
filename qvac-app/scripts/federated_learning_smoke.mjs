// FEDERATED LEARNING — the base idea, end to end, via the SERVER's actual path. Kiosk A
// learns + promotes an interaction edge; Kiosk B has its OWN seeded graph and replicates A's
// under a peer sub-log, then merges (exactly as server.js mergePeerGraph does, on its 15s
// interval). Proves: a CANDIDATE federated to B does NOT ground B's agent; once A PROMOTES it,
// the promotion federates and B's agent grounds on it — with only drug names crossing the wire.
//   node scripts/federated_learning_smoke.mjs
import os from "node:os"; import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { createFactStore, MemoryAdapter } from "@qvac/factstore";
import { HypercoreAdapter } from "@qvac/factstore/hypercore";
import { seedInteractions, screenInteractions, drugId } from "../src/medlens.js";
import { proposeEdge, promoteEdge } from "../src/edge-learning.js";
import { waitForSync, waitForLength } from "../src/kb-sync.js";

const tmp = (n) => { const d = path.join(os.tmpdir(), `fedl-${n}-${crypto.randomBytes(4).toString("hex")}`); fs.mkdirSync(d, { recursive: true }); return d; };
const X = "amiodarone", Y = "simvastatin";

// server.js mergePeerGraph (verbatim logic): pull a peer's edges into the local kb:medical,
// only when NEW or CHANGED (so a promotion — a meta change — propagates; unchanged is skipped).
async function mergePeerGraph(kbStore, peerLog) {
  const [peerEdges, localEdges] = await Promise.all([
    kbStore.fold(peerLog, { predicate: "interacts_with" }).then((r) => r.facts),
    kbStore.fold("kb:medical", { predicate: "interacts_with" }).then((r) => r.facts),
  ]);
  const sig = (f) => JSON.stringify([f.object, f.meta?.proposed, f.meta?.severity, f.confidence]);
  const localById = new Map(localEdges.map((f) => [f.statementId, sig(f)]));
  let merged = 0;
  for (const f of peerEdges) {
    if (localById.get(f.statementId) === sig(f)) continue;
    await kbStore.assert("kb:medical", { statementId: f.statementId, subject: f.subject, predicate: "interacts_with", object: f.object, source: f.source || "peer", confidence: f.confidence, meta: f.meta });
    merged++;
  }
  return merged;
}

// Kiosk A — owns its graph, learns a candidate edge.
const aA = new HypercoreAdapter({ storage: tmp("A") }); const kbA = createFactStore({ adapter: aA });
await seedInteractions(kbA);
await proposeEdge(kbA, { a: X, b: Y, severity: "major", note: "amiodarone inhibits CYP3A4 → raised simvastatin, myopathy", contributedBy: "kioskA" });
const aCore = aA.cores.get("kb:medical");

// Kiosk B — its OWN seeded graph; replicates A's under a peer sub-log (the server's path).
const bA = new HypercoreAdapter({ storage: tmp("B") }); const kbB = createFactStore({ adapter: bA });
await seedInteractions(kbB);
const peerLog = "kb:peer:A";
const bRemote = await bA.addRemoteCore(peerLog, await aA.coreKey("kb:medical"));
const patientB = createFactStore({ adapter: new MemoryAdapter() });
await patientB.assert("p", { subject: "p", predicate: "takes", object: { ref: drugId(X) }, source: "intake" });
const screenB = async () => (await screenInteractions(patientB, { patientLog: "p", candidate: Y, kbStore: kbB })).length;

const as = aA.replicate(true), bs = bA.replicate(false);
as.on("error", () => {}); bs.on("error", () => {});
as.pipe(bs).pipe(as);
await waitForSync(bRemote);
await mergePeerGraph(kbB, peerLog);
const whileCandidate = await screenB();
console.log(`[B] after merging A's CANDIDATE: agent flags ${X}+${Y}? ${whileCandidate} (must be 0)`);

const before = bRemote.length;
await promoteEdge(kbA, `lx:${drugId(X)}>${drugId(Y)}`, { by: "vet:network", severity: "major" });
await waitForLength(bRemote, before + 1);
await mergePeerGraph(kbB, peerLog);
const afterPromote = await screenB();
console.log(`[B] after A PROMOTED + re-merge: agent flags ${X}+${Y}? ${afterPromote} (must be 1)`);

const ok = whileCandidate === 0 && afterPromote === 1;
console.log(`\n${ok ? "PASS" : "FAIL"} — A's learned+promoted edge federated to B and grounds B's agent (candidate stayed un-grounded)`);
await aA.close(); await bA.close();
process.exit(ok ? 0 : 1);
