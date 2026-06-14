// Hypercore shared-KB replication smoke — proves the interaction graph replicates from a
// WRITER kiosk to a READER kiosk WITHOUT a server, and that a LIVE update propagates.
// Uses direct piped replication streams (no DHT) so it runs offline/in CI.
//   node scripts/kb_sync_smoke.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createFactStore } from "@qvac/factstore";
import { HypercoreAdapter } from "@qvac/factstore/hypercore";
import { seedInteractions, drugId } from "../src/medlens.js";
import { waitForSync, waitForLength } from "../src/kb-sync.js";

const tmp = (n) => { const d = path.join(os.tmpdir(), `kbsync-${n}-${crypto.randomBytes(4).toString("hex")}`); fs.mkdirSync(d, { recursive: true }); return d; };
const LOG = "kb:medical";
const ixCount = async (store) => (await store.fold(LOG, { predicate: "interacts_with" })).facts.length;

// --- writer kiosk: owns the interaction graph ---
const wAdapter = new HypercoreAdapter({ storage: tmp("writer") });
const writer = createFactStore({ adapter: wAdapter });
await seedInteractions(writer);
const key = await wAdapter.coreKey(LOG);
const seeded = await ixCount(writer);
console.log(`[writer] seeded ${seeded} interaction edges; core key ${key.slice(0, 16)}…`);

// --- reader kiosk: starts empty, replicates the writer's core by key ---
const rAdapter = new HypercoreAdapter({ storage: tmp("reader") });
const reader = createFactStore({ adapter: rAdapter });
const remote = await rAdapter.addRemoteCore(LOG, key);
console.log(`[reader] before replication: ${await ixCount(reader)} edges`);

// Direct replication (stands in for a hyperswarm connection).
const ws = wAdapter.replicate(true), rs = rAdapter.replicate(false);
ws.on("error", () => {}); rs.on("error", () => {});
ws.pipe(rs).pipe(ws);
await waitForSync(remote);
const replicated = await ixCount(reader);
console.log(`[reader] after replication:  ${replicated} edges`);

// --- live update: writer authors a NEW interaction; reader should see it ---
const before = remote.length;
await writer.assert(LOG, { statementId: "ix:demo>live", subject: drugId("demoA"), predicate: "interacts_with", object: { ref: drugId("demoB") }, source: "authored", meta: { severity: "major", note: "live-replication demo edge" } });
await waitForLength(remote, before + 1);
const afterLive = await ixCount(reader);
const sawLive = (await reader.fold(LOG, { subject: drugId("demoA") })).facts.some((f) => f.object?.ref === drugId("demoB"));
console.log(`[reader] after live write:   ${afterLive} edges; sees the new edge: ${sawLive}`);

const ok = replicated === seeded && afterLive === seeded + 1 && sawLive;
console.log(`\n${ok ? "PASS" : "FAIL"} — replication ${replicated === seeded ? "OK" : "MISMATCH"}, live propagation ${sawLive ? "OK" : "FAILED"}`);
await wAdapter.close(); await rAdapter.close();
process.exit(ok ? 0 : 1);
