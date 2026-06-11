// Per-encounter audit log — append-only, hash-chained, tamper-evident.
//
// One JSONL file per patient encounter under MEDPSY_AUDIT_DIR (default ./audit). Each
// line is one event; events are written gradually as they happen (raw model I/O from the
// /v1 shim + UI events from the client). Each event carries seq + prevHash + hash, where
//   hash = sha256( canonical({v,encounterId,seq,ts,type,actor,data,prevHash}) )
// so the chain enforces order and makes any edit/deletion/reorder detectable. A signed
// export bundle binds the chain head to a device key for sharing.
//
// Everything stays on-device (the app's offline/PII invariant); raw patient text is PHI,
// so the audit dir should be access-controlled / encrypted at rest in production.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const AUDIT_DIR = process.env.MEDPSY_AUDIT_DIR || path.join(import.meta.dirname, "..", "audit");
const AUDIT_KEY = process.env.MEDPSY_AUDIT_KEY || "medpsy-demo-device-key"; // prod: per-device secret
const SCHEMA_V = 1;
const GENESIS = "GENESIS";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const nowIso = () => new Date().toISOString();
const safeId = (id) => /^[A-Za-z0-9._-]{1,128}$/.test(id || "");          // path-injection guard
const fileFor = (id) => path.join(AUDIT_DIR, `${id}.jsonl`);

// Canonical bytes that get hashed (everything but the hash itself, fixed field order).
function canonical(ev) {
  return JSON.stringify({
    v: ev.v, encounterId: ev.encounterId, seq: ev.seq, ts: ev.ts,
    type: ev.type, actor: ev.actor, data: ev.data, prevHash: ev.prevHash,
  });
}

// --- per-encounter head cache + append mutex (single Node process, serialize per id) ---
const heads = new Map(); // encounterId -> { seq, hash }
const locks = new Map(); // encounterId -> tail promise

function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(id, run.then(() => {}, () => {}));
  return run;
}

function loadHead(id) {
  if (heads.has(id)) return heads.get(id);
  let head = { seq: -1, hash: GENESIS };
  try {
    const txt = fs.readFileSync(fileFor(id), "utf8").trimEnd();
    if (txt) {
      const last = JSON.parse(txt.slice(txt.lastIndexOf("\n") + 1));
      head = { seq: last.seq, hash: last.hash };
    }
  } catch { /* no file yet */ }
  heads.set(id, head);
  return head;
}

// Append one event. Returns the written event (with seq + hash).
export function append(encounterId, type, data = {}, actor = "system") {
  if (!safeId(encounterId)) return Promise.reject(new Error("invalid encounterId"));
  return withLock(encounterId, () => {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const head = loadHead(encounterId);
    const ev = { v: SCHEMA_V, encounterId, seq: head.seq + 1, ts: nowIso(), type, actor, data, prevHash: head.hash };
    ev.hash = sha256(canonical(ev));
    fs.appendFileSync(fileFor(encounterId), JSON.stringify(ev) + "\n");
    heads.set(encounterId, { seq: ev.seq, hash: ev.hash });
    return ev;
  });
}

// Read all events for an encounter (in order).
export function read(encounterId) {
  if (!safeId(encounterId)) throw new Error("invalid encounterId");
  let txt;
  try { txt = fs.readFileSync(fileFor(encounterId), "utf8"); }
  catch { return []; }
  return txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Recompute the chain — detects any tampering. Returns { ok, count, brokenAt? }.
export function verify(events) {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.seq !== i || ev.prevHash !== prev) return { ok: false, count: events.length, brokenAt: i, reason: "seq/prevHash" };
    const h = sha256(canonical(ev));
    if (h !== ev.hash) return { ok: false, count: events.length, brokenAt: i, reason: "hash" };
    prev = h;
  }
  return { ok: true, count: events.length, head: prev };
}

// Summaries for the index/list view (newest first).
export function list() {
  let files;
  try { files = fs.readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".jsonl")); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, "");
    const events = read(id);
    if (!events.length) continue;
    const find = (t) => events.filter((e) => e.type === t);
    const patient = find("patient").slice(-1)[0]?.data;
    const outcome = find("outcome").slice(-1)[0]?.data;
    out.push({
      encounterId: id,
      start: events[0].ts,
      last: events[events.length - 1].ts,
      events: events.length,
      patient: patient ? { name: patient.name, id: patient.id } : null,
      lang: find("encounter.start").slice(-1)[0]?.data?.lang || null,
      decision: outcome?.decision || null,
      band: outcome?.band || null,
      integrity: verify(events).ok,
    });
  }
  return out.sort((a, b) => (a.start < b.start ? 1 : -1));
}

// Self-contained, signed bundle for sharing/import.
export function exportBundle(encounterId) {
  const events = read(encounterId);
  const v = verify(events);
  const head = events.length ? events[events.length - 1].hash : GENESIS;
  return {
    format: "medpsy-audit", v: SCHEMA_V, encounterId,
    exportedAt: nowIso(), events,
    head: { seq: events.length - 1, hash: head },
    integrity: v,
    signature: sha256(`${head}:${AUDIT_KEY}`), // demo: device-key HMAC-ish; prod: ECDSA
  };
}

// Verify + (optionally) persist an imported bundle. Returns { ok, encounterId, events, integrity, signatureOk, imported }.
export function importBundle(bundle, { persist = true } = {}) {
  if (!bundle || bundle.format !== "medpsy-audit" || !Array.isArray(bundle.events))
    return { ok: false, reason: "not a medpsy-audit bundle" };
  const integrity = verify(bundle.events);
  const head = bundle.events.length ? bundle.events[bundle.events.length - 1].hash : GENESIS;
  const signatureOk = bundle.signature === sha256(`${head}:${AUDIT_KEY}`);
  const id = bundle.encounterId;
  let imported = false;
  if (persist && integrity.ok && safeId(id) && !fs.existsSync(fileFor(id))) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(fileFor(id), bundle.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    heads.delete(id);
    imported = true;
  }
  return { ok: integrity.ok, encounterId: id, events: bundle.events, integrity, signatureOk, imported };
}

export const _internal = { AUDIT_DIR, fileFor };
