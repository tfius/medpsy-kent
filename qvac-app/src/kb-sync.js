// Live replication of a shared knowledge log (the authored interaction graph) between
// kiosks over Hyperswarm — NO server. One device WRITES the log (its hypercore); peers
// REPLICATE it read-only and ground the agent on the merged view. Edit a protocol/interaction
// on one kiosk and the others pick it up. Built on @qvac/factstore's HypercoreAdapter; this
// module is the hyperswarm wiring the adapter flagged as "the remaining step".
//
//   writer:  const { keyHex } = await shareLog(adapter, "kb:medical")  // share keyHex
//   reader:  await joinLog(adapter, "kb:medical", keyHex)              // now folds see the peer's facts
import Hyperswarm from "hyperswarm";

const BOOTSTRAP = process.env.MEDPSY_P2P_BOOTSTRAP
  ? process.env.MEDPSY_P2P_BOOTSTRAP.split(",").map((s) => { const [host, port] = s.split(":"); return { host, port: Number(port) }; })
  : undefined;

// Writer side: announce a local log's core on the DHT (topic = its discoveryKey) and
// replicate every connection. Returns { keyHex, swarm } — hand keyHex to peers.
export async function shareLog(adapter, log, { bootstrap = BOOTSTRAP } = {}) {
  const keyHex = await adapter.coreKey(log);
  const topic = await adapter.discoveryKey(log);
  const swarm = new Hyperswarm({ bootstrap });
  swarm.on("connection", (conn) => { conn.on("error", () => {}); adapter.replicate(conn); });
  await swarm.join(topic, { server: true, client: false }).flushed();
  return { keyHex, topic, swarm };
}

// Reader side: alias the peer's core (by hex key) to `log`, join its topic, replicate, and
// pull the latest. Returns { swarm }. After this, factstore folds of `log` see the peer's facts.
export async function joinLog(adapter, log, keyHex, { bootstrap = BOOTSTRAP, timeoutMs = 12000 } = {}) {
  const core = await adapter.addRemoteCore(log, keyHex);
  const swarm = new Hyperswarm({ bootstrap });
  swarm.on("connection", (conn) => { conn.on("error", () => {}); adapter.replicate(conn); });
  swarm.join(core.discoveryKey, { server: false, client: true });
  await swarm.flush().catch(() => {}); // let discovery settle
  await waitForSync(core, { timeoutMs }); // wait for a peer to deliver the core's contents
  return { swarm, core };
}

// Wait until a replica core has data from a peer (or timeout). update() alone can resolve
// before the replication handshake completes — so we race it against the first `append`.
export function waitForSync(core, { timeoutMs = 12000 } = {}) {
  if (core.length > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(t); core.off("append", onAppend); resolve(core.length > 0); };
    const onAppend = () => finish();
    const t = setTimeout(finish, timeoutMs);
    core.once("append", onAppend);
    core.update({ wait: true }).then(() => { if (core.length > 0) finish(); }).catch(() => {});
  });
}

// Wait until a replica core reaches at least `target` blocks (for live-update propagation).
export async function waitForLength(core, target, { timeoutMs = 12000 } = {}) {
  const start = Date.now();
  while (core.length < target && Date.now() - start < timeoutMs) {
    await core.update({ wait: true }).catch(() => {});
    if (core.length < target) await new Promise((r) => setTimeout(r, 150));
  }
  return core.length >= target;
}
