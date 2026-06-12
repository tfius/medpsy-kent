// End-to-end test of the P2P audit handoff (src/p2p.js): the sender offers a real
// encounter bundle in this process; the receiver runs in a CHILD process with its own
// audit dir + device key, so it genuinely exercises the two-device path (Hyperswarm
// discovery via pairing-code topic, Noise channel, ed25519 verify, persist on import).
//
//   node scripts/p2p_test.mjs [encounterId]
//
// Needs network access for the public DHT bootstrap (or MEDPSY_P2P_BOOTSTRAP).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as p2p from "../src/p2p.js";
import * as audit from "../src/audit.js";

const encounterId = process.argv[2] || audit.list()[0]?.encounterId;
if (!encounterId) { console.error("no encounters in the audit dir to test with"); process.exit(1); }

const recvDir = fs.mkdtempSync(path.join(os.tmpdir(), "medpsy-p2p-recv-"));
console.log(`sender:   offering encounter ${encounterId}`);
const { code, expiresAt, device } = await p2p.offer(encounterId);
console.log(`sender:   pairing code ${code} (expires ${expiresAt}) from device "${device.name}"`);

// Receiver child: separate audit dir + device key = a different "device".
function pathToFileURLStr(rel) { return new URL(rel, import.meta.url).href; }
const child = spawn(process.execPath, ["--input-type=module", "-e", `
  const p2p = await import(${JSON.stringify(pathToFileURLStr("../src/p2p.js"))});
  const audit = await import(${JSON.stringify(pathToFileURLStr("../src/audit.js"))});
  const r = await p2p.receive(${JSON.stringify(code)});
  const onDisk = audit.read(r.encounterId);
  const v = audit.verify(onDisk);
  console.log("RESULT " + JSON.stringify({
    ok: r.ok, signatureOk: r.signatureOk, imported: r.imported,
    signedBy: r.signedBy, sender: r.sender, persistedEvents: onDisk.length, persistedChainOk: v.ok,
  }));
  process.exit(0);
`], {
  env: { ...process.env, MEDPSY_AUDIT_DIR: recvDir, MEDPSY_DEVICE_KEY_FILE: path.join(recvDir, "device-key.json"), MEDPSY_DEVICE_NAME: "pharmacist-station" },
  stdio: ["ignore", "pipe", "inherit"],
});

let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
const codeExit = await new Promise((r) => child.on("exit", r));

const m = out.match(/RESULT (\{.*\})/);
const result = m ? JSON.parse(m[1]) : null;
// The ack can land moments after the child exits — poll briefly.
let senderStatus;
for (let i = 0; i < 50; i++) {
  senderStatus = p2p.status().offers.find((o) => o.code === code);
  if (senderStatus?.status !== "waiting") break;
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`sender:   offer status -> ${senderStatus?.status}, sentTo -> ${senderStatus?.sentTo?.name || "?"}`);

const pass = codeExit === 0 && result
  && result.ok && result.signatureOk && result.imported
  && result.persistedChainOk && result.persistedEvents > 0
  && result.signedBy?.scheme === "ed25519"
  && senderStatus?.status === "sent";
console.log(pass ? "\nPASS — bundle handed off device-to-device, chain + device signature verified" : "\nFAIL");
fs.rmSync(recvDir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
