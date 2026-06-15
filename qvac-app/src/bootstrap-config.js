// Config bootstrap — so you don't have to juggle a dozen env vars (esp. for a multi-kiosk
// mesh). Turns CLI flags + an optional config file + a --profile into process.env BEFORE the
// rest of the app reads it. Import this FIRST (server.js does). Existing env still works.
//
// Precedence (highest first):  CLI flag  >  existing env  >  config file  >  profile default
//
//   node src/server.js --profile clinic-b --port 8788 --consult-code CLINIC
//   node src/server.js --config ./my.json
//   medpsy.config.json (auto-loaded from cwd): { "backend":"qvac", "consultCode":"CLINIC", "noSpeech":true }
//
// --profile <name> namespaces ALL per-kiosk state under data/profiles/<name>/ (kb, facts, audit,
// device key) and sets the device name — one flag instead of 5 path env vars.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return undefined; const v = args[i + 1]; return (v && !v.startsWith("--")) ? v : "true"; };

// config file: --config <path>, else ./medpsy.config.json if present
const cfgArg = flag("config");
const cfgPath = (cfgArg && cfgArg !== "true") ? cfgArg : path.join(process.cwd(), "medpsy.config.json");
let file = {};
try {
  if (fs.existsSync(cfgPath)) { file = JSON.parse(fs.readFileSync(cfgPath, "utf8")); console.log(`[config] loaded ${cfgPath}`); }
} catch (e) { console.warn(`[config] ignoring ${cfgPath}: ${e?.message || e}`); }

// CLI flag > existing env > config-file value
const set = (env, flagVal, fileVal) => {
  const v = flagVal ?? process.env[env] ?? (fileVal != null ? (Array.isArray(fileVal) ? fileVal.join(",") : String(fileVal)) : undefined);
  if (v !== undefined) process.env[env] = String(v);
};
set("MEDPSY_BACKEND", flag("backend"), file.backend);
set("API_PORT", flag("port"), file.port);
set("MEDPSY_CONSULT_CODE", flag("consult-code"), file.consultCode);
set("MEDPSY_CONSULT_MEMBERS", flag("members"), file.members);
set("MEDPSY_KB_SYNC_MS", flag("kb-sync-ms"), file.kbSyncMs);
set("MEDPSY_DEVICE_NAME", flag("device-name"), file.deviceName);
if (flag("no-speech") || file.noSpeech) process.env.MEDPSY_NO_SPEECH ??= "1";

const profile = (flag("profile") && flag("profile") !== "true" ? flag("profile") : undefined) ?? process.env.MEDPSY_PROFILE ?? file.profile;
if (profile) {
  const dir = path.join(process.cwd(), "data", "profiles", profile);
  process.env.MEDPSY_KB_DIR ??= path.join(dir, "kb-cores");
  process.env.MEDPSY_FACTS_DIR ??= path.join(dir, "facts");
  process.env.MEDPSY_AUDIT_DIR ??= path.join(dir, "audit");
  process.env.MEDPSY_DEVICE_KEY_FILE ??= path.join(dir, "device-key.json");
  process.env.MEDPSY_DEVICE_NAME ??= profile;
  console.log(`[config] profile "${profile}" → ${dir}`);
}
