// Append-only, hash-chained log over a pluggable storage adapter. Generic: it stores
// arbitrary opaque `payload` objects and stamps each record with seq + transaction time
// (ts) + prevHash + hash, so any edit/deletion/reorder is detectable. This is the
// tamper-evident substrate the FactStore builds on.
//
// Platform-agnostic: the hash function is injected (node:crypto in Node, a portable
// sha256 in Bare/browser), and storage is an adapter — no fs/crypto imports here.
//
// Record shape:  { v, log, seq, ts, payload, prevHash, hash }
// Hashed bytes:  canonical = JSON.stringify({ v, log, seq, ts, payload, prevHash })

const GENESIS = "GENESIS";

export class ChainLog {
  constructor({ adapter, hash, now, v = 1 }) {
    if (!adapter) throw new Error("ChainLog requires an adapter");
    if (typeof hash !== "function") throw new Error("ChainLog requires a hash function");
    this.adapter = adapter;
    this.hash = hash;
    this.now = now || (() => new Date().toISOString());
    this.v = v;
    this.heads = new Map(); // log -> { seq, hash }
    this.locks = new Map(); // log -> tail promise (serialize appends per log)
  }

  // NB: hashes JSON with insertion-order keys (same approach as the app's audit log). Stable
  // within a V8-family runtime (Node/Bare). Cross-runtime hash interop would need a sorted
  // canonical JSON — out of scope until a non-V8 exporter is a real use case.
  canonical(rec) {
    return JSON.stringify({ v: rec.v, log: rec.log, seq: rec.seq, ts: rec.ts, payload: rec.payload, prevHash: rec.prevHash });
  }

  _withLock(log, fn) {
    const prev = this.locks.get(log) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(log, run.then(() => {}, () => {}));
    return run;
  }

  async _head(log) {
    if (this.heads.has(log)) return this.heads.get(log);
    const lines = await this.adapter.read(log);
    let head = { seq: -1, hash: GENESIS };
    if (lines.length) { const last = JSON.parse(lines[lines.length - 1]); head = { seq: last.seq, hash: last.hash }; }
    this.heads.set(log, head);
    return head;
  }

  // Append one payload; returns the full chained record.
  append(log, payload) {
    return this._withLock(log, async () => {
      const head = await this._head(log);
      const rec = { v: this.v, log, seq: head.seq + 1, ts: this.now(), payload, prevHash: head.hash };
      rec.hash = this.hash(this.canonical(rec));
      await this.adapter.append(log, JSON.stringify(rec));
      this.heads.set(log, { seq: rec.seq, hash: rec.hash });
      return rec;
    });
  }

  // Import a bundle's records VERBATIM (preserving original seq/ts/hash so the chain still
  // verifies) into a log that must be empty — atomically, under the per-log lock, so two
  // concurrent imports can't both pass the emptiness check and fork the chain. Returns
  // whether it imported (false if the log already had records).
  importIfEmpty(log, records) {
    return this._withLock(log, async () => {
      const existing = await this.adapter.read(log);
      if (existing.length) return false;
      for (const r of records) await this.adapter.append(log, JSON.stringify(r));
      const last = records[records.length - 1];
      this.heads.set(log, last ? { seq: last.seq, hash: last.hash } : { seq: -1, hash: GENESIS });
      return true;
    });
  }

  async read(log) {
    return (await this.adapter.read(log)).map((l) => JSON.parse(l));
  }

  invalidate(log) { this.heads.delete(log); }

  // Recompute the chain — detects any tampering. Returns { ok, count, brokenAt?, reason? }.
  verify(records) {
    let prev = GENESIS;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (r.seq !== i || r.prevHash !== prev) return { ok: false, count: records.length, brokenAt: i, reason: "seq/prevHash" };
      const h = this.hash(this.canonical(r));
      if (h !== r.hash) return { ok: false, count: records.length, brokenAt: i, reason: "hash" };
      prev = h;
    }
    return { ok: true, count: records.length, head: prev };
  }
}

export { GENESIS };
