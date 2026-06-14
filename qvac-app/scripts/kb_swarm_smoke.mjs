// Shared-KB over the REAL hyperswarm path (not direct streams): a writer shares its
// interaction graph on the DHT, a reader joins by key and replicates it. Needs network
// (public DHT bootstrap). Proves src/kb-sync.js shareLog/joinLog end-to-end.
//   node scripts/kb_swarm_smoke.mjs
import os from "node:os"; import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { createFactStore } from "@qvac/factstore";
import { HypercoreAdapter } from "@qvac/factstore/hypercore";
import { seedInteractions, drugId } from "../src/medlens.js";
import { shareLog, joinLog, waitForLength } from "../src/kb-sync.js";

const tmp = (n) => { const d = path.join(os.tmpdir(), `kbsw-${n}-${crypto.randomBytes(4).toString("hex")}`); fs.mkdirSync(d, { recursive: true }); return d; };
const LOG = "kb:medical";
const count = (s) => s.fold(LOG, { predicate: "interacts_with" }).then((r) => r.facts.length);

const wA = new HypercoreAdapter({ storage: tmp("w") }); const w = createFactStore({ adapter: wA });
await seedInteractions(w);
const seeded = await count(w);
console.log(`[writer] seeded ${seeded} edges; announcing on the DHT…`);
const { keyHex, swarm: wSwarm } = await shareLog(wA, LOG);
console.log(`[writer] sharing key ${keyHex.slice(0, 16)}…`);

const rA = new HypercoreAdapter({ storage: tmp("r") }); const r = createFactStore({ adapter: rA });
console.log(`[reader] joining over hyperswarm (DHT discovery, ~5–15 s)…`);
const { swarm: rSwarm, core } = await joinLog(rA, LOG, keyHex);
const replicated = await count(r);
console.log(`[reader] replicated ${replicated} edges over the swarm`);

// live: writer authors a new edge → reader should fold it in
const before = core.length;
await w.assert(LOG, { statementId: "ix:swarm>live", subject: drugId("swarmA"), predicate: "interacts_with", object: { ref: drugId("swarmB") }, source: "authored", meta: { severity: "major", note: "swarm live edge" } });
await waitForLength(core, before + 1, { timeoutMs: 15000 });
const afterLive = await count(r);
console.log(`[reader] after a live write: ${afterLive} edges`);

const ok = replicated === seeded && afterLive === seeded + 1;
console.log(`\n${ok ? "PASS" : "FAIL"} — swarm replication ${replicated === seeded ? "OK" : "MISMATCH"}, live ${afterLive === seeded + 1 ? "OK" : "FAILED"}`);
await wSwarm.destroy().catch(() => {}); await rSwarm.destroy().catch(() => {});
await wA.close().catch(() => {}); await rA.close().catch(() => {});
process.exit(ok ? 0 : 1);
