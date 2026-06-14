// Persistent consult-client smoke — a warm client joins once and reuses connections: the
// FIRST consult pays DHT discovery, the SECOND is fast. The responder runs in a SUBPROCESS
// with a DISTINCT device identity (a kiosk never answers itself — see the self-vote filter).
//   node scripts/consult_client_smoke.mjs
import { spawn } from "node:child_process";
import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";

const CODE = "SMOKE-CLIENT-01";
const SELF = new URL(import.meta.url).pathname;

if (process.argv[2] === "responder") {
  const { serveConsult } = await import("../src/consult.js");
  await serveConsult(CODE, async (q) => `answer to: ${q.slice(0, 30)}`, { vetFn: async () => ({ real: true, severity: "major", reason: "stub vet" }) });
  setInterval(() => {}, 1 << 30);
} else {
  const kid = spawn(process.execPath, [SELF, "responder"], {
    env: { ...process.env, MEDPSY_DEVICE_KEY_FILE: path.join(os.tmpdir(), `ccs-${crypto.randomBytes(3).toString("hex")}.json`), MEDPSY_DEVICE_NAME: "Responder" },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 6000)); // let the responder announce on the DHT first
  const { createConsultClient } = await import("../src/consult.js");
  const client = createConsultClient(CODE); // client-only (no vetFn)
  const t0 = Date.now();
  for (let i = 0; i < 14 && client.peerCount() < 1; i++) await new Promise((r) => setTimeout(r, 2000));
  const discovery = Date.now() - t0; // one-time DHT discovery cost
  const t1 = Date.now(); const r1 = await client.ask("first question");  const d1 = Date.now() - t1;
  const t2 = Date.now(); const r2 = await client.ask("second question"); const d2 = Date.now() - t2;
  const votes = await client.askVetAll({ a: "drug:warfarin", b: "drug:fluconazole", severity: "major", note: "x" });
  console.log(`[client] discovery (one-time): ${discovery} ms; then ask1 ${d1} ms, ask2 ${d2} ms — both warm`);
  console.log(`[client] askVetAll: ${votes.length} vote(s), real=${votes[0]?.verdict.real} sig=${votes[0]?.signatureOk}`);
  const ok = !!r1.answer && !!r2.answer && d1 < 3000 && d2 < 3000 && votes.length >= 1 && votes[0].signatureOk;
  console.log(`\n${ok ? "PASS" : "FAIL"} — warm client: each consult fast over the reused connection + jury vet`);
  kid.kill(); await client.close();
  process.exit(ok ? 0 : 1);
}
