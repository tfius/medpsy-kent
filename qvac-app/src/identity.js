// Device identity — a persistent ed25519 keypair so anything this device exports
// (audit bundles, future P2P handshakes) is attributable to *this* kiosk/station,
// not just "someone who knows the shared demo key". Uses hypercore-crypto (already
// in the @qvac/sdk dependency tree) so there are no new native deps.
//
// The keypair is generated on first use and stored at data/device-key.json
// (override: MEDPSY_DEVICE_KEY_FILE). The secret key never leaves this file;
// peers only ever see the public key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "hypercore-crypto";
import b4a from "b4a";

const KEY_FILE = process.env.MEDPSY_DEVICE_KEY_FILE
  || path.join(import.meta.dirname, "..", "data", "device-key.json");
const DEVICE_NAME = process.env.MEDPSY_DEVICE_NAME || os.hostname();

let cached = null;

function loadOrCreate() {
  if (cached) return cached;
  try {
    const k = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    if (k.publicKey && k.secretKey) { cached = k; return cached; }
  } catch { /* no key yet */ }
  const kp = crypto.keyPair();
  cached = {
    publicKey: b4a.toString(kp.publicKey, "hex"),
    secretKey: b4a.toString(kp.secretKey, "hex"),
    name: DEVICE_NAME,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, JSON.stringify(cached, null, 2), { mode: 0o600 });
  return cached;
}

// Public identity — safe to share with peers / embed in bundles.
export function getIdentity() {
  const k = loadOrCreate();
  return { publicKey: k.publicKey, name: k.name || DEVICE_NAME };
}

// Where this device's keypair lives (honors MEDPSY_DEVICE_KEY_FILE / --profile). For the CLI.
export function keyFilePath() { return KEY_FILE; }
export function keyExists() { try { return fs.existsSync(KEY_FILE); } catch { return false; } }

// Sign a UTF-8 string with this device's key -> hex signature.
export function sign(message) {
  const k = loadOrCreate();
  return b4a.toString(crypto.sign(b4a.from(message, "utf-8"), b4a.from(k.secretKey, "hex")), "hex");
}

// Verify a hex signature against any device's hex public key.
export function verify(message, signatureHex, publicKeyHex) {
  try {
    return crypto.verify(b4a.from(message, "utf-8"), b4a.from(signatureHex, "hex"), b4a.from(publicKeyHex, "hex"));
  } catch {
    return false;
  }
}
