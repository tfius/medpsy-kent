// Jury vetting smoke — proves consultVetAll collects SIGNED verdicts from MULTIPLE distinct
// peer devices (not just the first). Spawns two responder subprocesses with distinct device
// identities, then asks the jury to vet an edge over the real DHT.
//   node scripts/consult_jury_smoke.mjs
import { spawn } from "node:child_process";
import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";

const CODE = "SMOKE-JURY-01";
const SELF = new URL(import.meta.url).pathname;

if (process.argv[2] === "responder") {
  const { serveConsult } = await import("../src/consult.js");
  const { getIdentity } = await import("../src/identity.js");
  await serveConsult(CODE, async () => "n/a", { vetFn: async () => ({ real: true, severity: process.env.SEV || "major", reason: `${getIdentity().name} confirms` }) });
  console.log(`[child] ${getIdentity().name} serving vet`);
  setInterval(() => {}, 1 << 30); // stay alive until parent kills us
} else {
  const kids = ["A", "B"].map((n, i) => spawn(process.execPath, [SELF, "responder"], {
    env: { ...process.env,
      MEDPSY_DEVICE_KEY_FILE: path.join(os.tmpdir(), `jurykey-${n}-${crypto.randomBytes(3).toString("hex")}.json`),
      MEDPSY_DEVICE_NAME: `Kiosk-${n}`, SEV: i ? "moderate" : "major" },
    stdio: "inherit",
  }));
  await new Promise((r) => setTimeout(r, 4000)); // let both responders announce on the DHT
  const { consultVetAll } = await import("../src/consult.js");
  console.log("[parent] asking the jury to vet…");
  const votes = await consultVetAll(CODE, { a: "drug:warfarin", b: "drug:fluconazole", severity: "major", note: "CYP2C9" }, { timeoutMs: 22000, collectMs: 6000 });
  console.log("[parent] jury:", JSON.stringify(votes.map((v) => ({ by: v.peer?.name, real: v.verdict.real, sev: v.verdict.severity, sig: v.signatureOk }))));
  kids.forEach((k) => k.kill());
  const names = new Set(votes.map((v) => v.peer?.name));
  const ok = votes.length >= 2 && names.size >= 2 && votes.every((v) => v.signatureOk);
  console.log(`\n${ok ? "PASS" : "FAIL"} — jury of ${names.size} distinct signed peer(s) (need ≥2)`);
  process.exit(ok ? 0 : 1);
}
