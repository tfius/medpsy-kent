// Hypercore storage adapter — each log is its own append-only hypercore in a corestore.
// This is the durable, single-writer-per-log backing that makes a log REPLICABLE: a
// device shares its cores over hyperswarm and another device replicates them into its own
// corestore, after which FactStore.foldView merges the per-device sub-logs into one
// bi-temporal view (the multi-writer CRDT merge — see store.js). The merge logic is fully
// tested with the in-memory adapter; wiring the actual hyperswarm replication + a live
// two-device test is the remaining step.
//
// corestore/hypercore/b4a are OPTIONAL peers (they ship with @qvac/sdk); importing this
// module without them throws, while the core package keeps working on the other adapters.
//
//   new HypercoreAdapter({ storage: "./facts-cores" })   // a directory path
import Corestore from "corestore";
import b4a from "b4a";

const LOGS_INDEX = "__logs__"; // a manifest core listing the log names (corestore keys by hash)

export class HypercoreAdapter {
  constructor({ storage }) {
    if (!storage) throw new Error("HypercoreAdapter requires { storage } (a directory path or storage instance)");
    this.store = new Corestore(storage);
    this.cores = new Map();
    this.remotes = new Set(); // log names backed by a REPLICATED remote core (read-only)
    this._manifest = null;
  }

  // --- replication (the "shared log" path: one writer, N read-only replicas) ---

  // The public key of a local log's core — hand this to a peer so they can replicate it.
  async coreKey(log) {
    const core = await this._core(log);
    return b4a.toString(core.key, "hex");
  }

  // Alias a log name to a PEER's core (by hex key) — a read-only replica that syncs over any
  // stream passed to replicate(). Reads call core.update() first (see read()).
  async addRemoteCore(log, keyHex) {
    if (this.cores.has(log)) return this.cores.get(log);
    const core = this.store.get({ key: b4a.from(keyHex, "hex") });
    await core.ready();
    this.cores.set(log, core);
    this.remotes.add(log);
    return core;
  }

  // discoveryKey for a log's core — the hyperswarm topic both sides join.
  async discoveryKey(log) { return (await this._core(log)).discoveryKey; }

  // Wire a replication stream (a hyperswarm connection, or a piped duplex in tests) into this
  // corestore — replicates every core both sides share interest in.
  replicate(stream, opts) { return this.store.replicate(stream, opts); }

  async _core(log) {
    if (this.cores.has(log)) return this.cores.get(log);
    const core = this.store.get({ name: log });
    await core.ready();
    this.cores.set(log, core);
    return core;
  }
  async _names() {
    if (!this._manifest) { this._manifest = this.store.get({ name: LOGS_INDEX }); await this._manifest.ready(); }
    return this._manifest;
  }

  async append(log, line) {
    const core = await this._core(log);
    const first = core.length === 0;
    await core.append(b4a.from(line));               // commit data first…
    if (first) { const man = await this._names(); await man.append(b4a.from(log)); } // …then register the name (no orphan manifest entry on a failed append)
  }

  async read(log) {
    const core = await this._core(log);
    // A REPLICATED remote core is sparse: learn the peer's latest length first. update()
    // returns once the swarm has a current view (or immediately if not connected).
    if (!core.writable) { try { await core.update(); } catch { /* offline — read what we have */ } }
    const out = [];
    // get() downloads the block if it's not local yet (remote cores); a short timeout keeps a
    // missing/offline block from hanging the fold.
    for (let i = 0; i < core.length; i++) {
      try { out.push(b4a.toString(await core.get(i, core.writable ? {} : { timeout: 5000 }))); }
      catch { break; } // can't fetch a block (peer gone) — return the contiguous prefix we have
    }
    return out;
  }

  async list() {
    const man = await this._names();
    const names = new Set(this.remotes);
    for (let i = 0; i < man.length; i++) names.add(b4a.toString(await man.get(i)));
    return [...names];
  }

  async close() { try { await this.store.close(); } catch { /* ignore */ } }
}
