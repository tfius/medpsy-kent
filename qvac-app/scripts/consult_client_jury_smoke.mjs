// Persistent-client jury + late-joiner smoke. The client fires askVetAll BEFORE any peer is
// connected; two distinct responders then come up at different times. The first to connect
// gets the broadcast; the second is reached by the late-joiner REPLAY (active requests are
// re-sent to peers that connect mid-window). Expect 2 distinct signed votes.
//   node scripts/consult_client_jury_smoke.mjs
import { spawn } from "node:child_process";
import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";

const CODE = "SMOKE-CJURY-01";
const SELF = new URL(import.meta.url).pathname;

if (process.argv[2] === "responder") {
  const { serveConsult } = await import("../src/consult.js");
  const { getIdentity } = await import("../src/identity.js");
  await new Promise((r) => setTimeout(r, Number(process.env.DELAY_MS || 0))); // stagger joins
  await serveConsult(CODE, async () => "n/a", { vetFn: async () => ({ real: true, severity: process.env.SEV || "major", reason: `${getIdentity().name}` }) });
  console.log(`[child] ${getIdentity().name} serving (after ${process.env.DELAY_MS || 0}ms)`);
  setInterval(() => {}, 1 << 30);
} else {
  const { createConsultClient } = await import("../src/consult.js");
  // Realistic ordering: clinician stations (responders) are up first, then the kiosk's
  // persistent client starts and connects to them.
  const kids = ["A", "B"].map((n, i) => spawn(process.execPath, [SELF, "responder"], {
    env: { ...process.env, MEDPSY_DEVICE_KEY_FILE: path.join(os.tmpdir(), `cjury-${n}-${crypto.randomBytes(3).toString("hex")}.json`),
      MEDPSY_DEVICE_NAME: `Kiosk-${n}`, SEV: i ? "moderate" : "major", DELAY_MS: "0" },
    stdio: "inherit",
  }));
  await new Promise((r) => setTimeout(r, 6000)); // let responders announce
  const client = createConsultClient(CODE);
  for (let i = 0; i < 14 && client.peerCount() < 2; i++) await new Promise((r) => setTimeout(r, 2000));
  console.log(`[parent] client warmed: ${client.peerCount()} peer(s) connected; firing askVetAll…`);
  const votes = await client.askVetAll({ a: "drug:warfarin", b: "drug:fluconazole", severity: "major", note: "x" }, { timeoutMs: 20000, collectMs: 7000 });
  console.log("[parent] jury:", JSON.stringify(votes.map((v) => ({ by: v.peer?.name, real: v.verdict.real, sig: v.signatureOk }))));
  kids.forEach((k) => k.kill()); await client.close();
  const names = new Set(votes.map((v) => v.peer?.name));
  const ok = names.size >= 2 && votes.every((v) => v.signatureOk);
  console.log(`\n${ok ? "PASS" : "FAIL"} — warm client collected ${names.size} distinct signed votes incl. a late joiner`);
  process.exit(ok ? 0 : 1);
}
