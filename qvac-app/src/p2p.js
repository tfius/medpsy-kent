// P2P audit-bundle handoff — kiosk → pharmacist station, device to device.
//
// Transport is Hyperswarm (already in the @qvac/sdk dependency tree): both sides
// derive a DHT topic from a short pairing code, the receiver shows/enters the code,
// and the bundle streams over Hyperswarm's end-to-end-encrypted Noise channel.
// No server, no cloud — PHI moves directly between the two authorized devices.
//
//   sender:    const { code } = await offer(encounterId)   // announce, wait for peer
//   receiver:  const result  = await receive(code)         // join, import, ack
//
// The bundle itself is the existing signed export (audit.exportBundle): hash-chained,
// ed25519-signed by the sending device, verified by audit.importBundle on arrival —
// the transport doesn't need to be trusted, only the signature does.
//
// Pairing codes are 8 chars of unambiguous base32 (~40 bits) and offers expire after
// OFFER_TTL_MS, so the window for code-guessing on the public DHT is small. Note:
// peer discovery uses the public Hyperswarm DHT bootstrap nodes; a fully offline
// LAN deployment needs a local bootstrap node (pass via MEDPSY_P2P_BOOTSTRAP).
import crypto from "node:crypto";
import Hyperswarm from "hyperswarm";
import b4a from "b4a";
import * as audit from "./audit.js";
import { getIdentity } from "./identity.js";

const OFFER_TTL_MS = Number(process.env.MEDPSY_P2P_OFFER_TTL_MS) || 5 * 60 * 1000;
const RECEIVE_TIMEOUT_MS = Number(process.env.MEDPSY_P2P_RECEIVE_TIMEOUT_MS) || 60 * 1000;
const BOOTSTRAP = process.env.MEDPSY_P2P_BOOTSTRAP
  ? process.env.MEDPSY_P2P_BOOTSTRAP.split(",").map((s) => { const [host, port] = s.split(":"); return { host, port: Number(port) }; })
  : undefined; // undefined -> public DHT bootstrap

// Crockford-ish base32 without ambiguous chars (no 0/O/1/I/L), grouped XXXX-XXXX.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function generateCode() {
  const bytes = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const normCode = (c) => (c || "").toUpperCase().replace(/[^2-9A-Z]/g, "");
const topicFor = (code) => crypto.createHash("sha256").update(`medpsy-handoff:v1:${normCode(code)}`).digest();

// One JSON message per line over the Noise stream (bundles are small).
function sendJson(conn, obj) { conn.write(JSON.stringify(obj) + "\n"); }
function onJsonLine(conn, cb) {
  let buf = "";
  conn.on("data", (chunk) => {
    buf += b4a.toString(chunk, "utf-8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // skip a malformed line only
      cb(msg); // dispatch outside the parse guard so handler errors aren't swallowed
    }
  });
}

// --- active offers (this process), keyed by NORMALIZED (undashed) code ---
const offers = new Map(); // normCode -> { encounterId, code, createdAt, expiresAt, status, sentTo, error, closedAt, _swarm, _timer }
const CLOSED_GRACE_MS = 60 * 1000; // keep terminal offers briefly so the UI can observe the final status

// Drop terminal offers whose grace window has passed (keeps the Map bounded).
function pruneOffers() {
  const cutoff = Date.now() - CLOSED_GRACE_MS;
  for (const [k, o] of offers) if (o.closedAt && new Date(o.closedAt).getTime() < cutoff) offers.delete(k);
}

async function closeOffer(code, status) {
  const o = offers.get(normCode(code));
  if (!o) return;
  if (status) o.status = status;
  o.closedAt = new Date().toISOString();
  clearTimeout(o._timer);
  const swarm = o._swarm;
  o._swarm = null;
  if (swarm) await swarm.destroy().catch(() => {});
}

// Announce an encounter's signed bundle under a fresh pairing code.
// Resolves as soon as the offer is live (not when the transfer happens).
export async function offer(encounterId) {
  const bundle = audit.exportBundle(encounterId);
  if (!bundle.events.length) throw new Error(`no events for encounter ${encounterId}`);
  if (!bundle.integrity.ok) throw new Error(`refusing to share a broken chain (broken at #${bundle.integrity.brokenAt})`);

  const code = generateCode();
  const swarm = new Hyperswarm({ bootstrap: BOOTSTRAP });
  const o = {
    encounterId, code,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + OFFER_TTL_MS).toISOString(),
    status: "waiting", sentTo: null, error: null, closedAt: null,
    _swarm: swarm, _timer: setTimeout(() => closeOffer(code, "expired"), OFFER_TTL_MS),
  };
  pruneOffers();
  offers.set(normCode(code), o);

  swarm.on("connection", (conn) => {
    conn.on("error", () => {});
    sendJson(conn, { kind: "medpsy-handoff", from: getIdentity(), bundle });
    onJsonLine(conn, (msg) => {
      if (msg.kind !== "medpsy-handoff-ack") return;
      o.sentTo = msg.from || null;
      closeOffer(code, msg.ok ? "sent" : "rejected");
      if (!msg.ok) o.error = msg.reason || "receiver rejected the bundle";
    });
  });
  await swarm.join(topicFor(code), { server: true, client: false }).flushed();
  return { code, encounterId, expiresAt: o.expiresAt, device: getIdentity() };
}

// Join a pairing code, receive the bundle, verify + import it, ack the sender.
export function receive(code, { persist = true, timeoutMs = RECEIVE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const swarm = new Hyperswarm({ bootstrap: BOOTSTRAP });
    let done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      swarm.destroy().catch(() => {});
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("timed out waiting for the sending device")), timeoutMs);

    swarm.on("connection", (conn) => {
      conn.on("error", () => {});
      onJsonLine(conn, (msg) => {
        if (msg.kind !== "medpsy-handoff" || !msg.bundle) return;
        const result = audit.importBundle(msg.bundle, { persist });
        sendJson(conn, {
          kind: "medpsy-handoff-ack",
          ok: result.ok && result.signatureOk,
          reason: result.ok ? (result.signatureOk ? null : "bad signature") : "broken chain",
          from: getIdentity(),
        });
        // Let the ack reach the sender before tearing the swarm down.
        conn.end();
        const close = () => finish(null, { ...result, sender: msg.from || null });
        conn.once("close", close);
        setTimeout(close, 1500);
      });
    });
    swarm.join(topicFor(code), { server: false, client: true });
  });
}

// Operator-facing status: this device + live offers (no secret material).
export function status() {
  pruneOffers();
  const list = [...offers.values()].map(({ _swarm, _timer, closedAt, ...pub }) => pub);
  return { device: getIdentity(), offers: list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) };
}

export async function cancel(code) {
  await closeOffer(code, "cancelled");
  return status();
}
