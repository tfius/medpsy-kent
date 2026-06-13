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
    this._manifest = null;
  }

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
    if (core.length === 0) { const man = await this._names(); await man.append(b4a.from(log)); } // register the name once
    await core.append(b4a.from(line));
  }

  async read(log) {
    const core = await this._core(log);
    const out = [];
    for (let i = 0; i < core.length; i++) out.push(b4a.toString(await core.get(i)));
    return out;
  }

  async list() {
    const man = await this._names();
    const names = new Set();
    for (let i = 0; i < man.length; i++) names.add(b4a.toString(await man.get(i)));
    return [...names];
  }

  async close() { try { await this.store.close(); } catch { /* ignore */ } }
}
