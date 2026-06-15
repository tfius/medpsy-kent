// `medpsy` CLI subcommands: device keys, signed audit bundles, membership rosters, and an
// interactive config scaffolder. bootstrap-config.js has already run (cli.js imports it
// first), so --profile/--config have set the env that identity.js / audit.js read.
import fs from "node:fs";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import * as identity from "./identity.js";
import * as audit from "./audit.js";
import { signRoster } from "./roster.js";

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const die = (m) => { console.error(`${C.r}${m}${C.x}`); process.exit(1); };

// --flag value | --bool | positionals in _
function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) { const v = args[i + 1]; out[a.slice(2)] = (v && !v.startsWith("-")) ? args[++i] : "true"; }
    else if (a === "-h") out.help = "true";
    else if (a === "-y") out.yes = "true";
    else if (a === "-o") out.o = args[++i];
    else out._.push(a);
  }
  return out;
}
const truthy = (v) => v === "true" || v === true;
const val = (v) => (v && v !== "true" ? v : "");

// ---- keygen ----
function keygen(a) {
  const file = identity.keyFilePath();
  const force = truthy(a.force) || truthy(a.f);
  if (force && identity.keyExists()) { fs.rmSync(file); console.error(`${C.y}⚠ removed existing key — regenerating (old signatures/membership will no longer verify)${C.x}`); }
  const fresh = !identity.keyExists();
  const id = identity.getIdentity(); // creates on first use
  console.error(`${C.b}device identity${C.x} ${C.d}(${fresh ? "new" : "existing"})${C.x}`);
  console.error(`  name:     ${id.name}`);
  console.error(`  key file: ${file} ${C.d}(secret, mode 0600 — never share)${C.x}`);
  console.error(`  ${C.d}public key (share this; used in rosters + bundle verification):${C.x}`);
  console.log(id.publicKey); // clean stdout = the public key
}

// ---- identity ----
function identityCmd(a) {
  const id = identity.getIdentity();
  console.log(truthy(a.json) ? JSON.stringify(id) : id.publicKey);
}

// ---- roster ----
function rosterCmd(a) {
  const roster = signRoster({ code: val(a.code), members: val(a.members).split(",").map((s) => s.trim()).filter(Boolean) });
  const json = JSON.stringify(roster, null, 2);
  const out = val(a.out);
  if (out) { fs.writeFileSync(out, json); console.error(`${C.g}wrote ${out}${C.x}`); }
  console.error(`${C.d}issuer ${identity.getIdentity().publicKey} — ${roster.members.length} member(s); each kiosk sets rosterIssuer to this key${C.x}`);
  console.log(out || json);
}

// ---- export / verify / import (signed audit bundles) ----
function exportCmd(a) {
  const id = a._[0] || die("usage: medpsy export <encounterId> [out.json]");
  const bundle = audit.exportBundle(id);
  if (!bundle.events.length) die(`no audit events for encounter "${id}"`);
  const out = a._[1] || `${id}.audit.json`;
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2));
  console.error(`${C.g}wrote ${out}${C.x} ${C.d}(${bundle.events.length} events, signed by ${bundle.device.name})${C.x}`);
  console.log(out);
}

function report(res) {
  const i = res.integrity || {};
  const signer = res.signedBy?.name || (res.signedBy?.publicKey ? `${res.signedBy.publicKey.slice(0, 16)}…` : res.signedBy?.scheme) || "?";
  console.error(`  encounter: ${res.encounterId}`);
  console.error(`  events:    ${res.events?.length ?? 0}`);
  console.error(`  chain:     ${i.ok ? `${C.g}✓ intact${C.x}` : `${C.r}✗ broken at #${i.brokenAt} (${i.reason})${C.x}`}`);
  console.error(`  signature: ${res.signatureOk ? `${C.g}✓ valid${C.x}` : `${C.r}✗ invalid${C.x}`} ${C.d}· signer: ${signer}${C.x}`);
}
function loadBundle(a) {
  const file = a._[0] || die(`usage: medpsy ${a._cmd} <bundle.json>`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { die(`cannot read ${file}: ${e?.message || e}`); }
}
function verifyCmd(a) {
  a._cmd = "verify";
  const res = audit.importBundle(loadBundle(a), { persist: false });
  if (res.reason) die(res.reason);
  report(res);
  const ok = res.integrity?.ok && res.signatureOk;
  console.log(ok ? "OK" : "FAIL");
  process.exit(ok ? 0 : 1);
}
function importCmd(a) {
  a._cmd = "import";
  const res = audit.importBundle(loadBundle(a), { persist: true });
  if (res.reason) die(res.reason);
  report(res);
  console.error(res.imported
    ? `${C.g}✓ imported ${res.encounterId}${C.x}`
    : `${C.y}not imported (${res.integrity?.ok && res.signatureOk ? "already present" : "failed verification — fails closed"})${C.x}`);
  process.exit(res.imported || (res.integrity?.ok && res.signatureOk) ? 0 : 1);
}

// ---- init (interactive config scaffolder) ----
async function init(a) {
  const out = val(a.o) || val(a.out) || "medpsy.config.json";
  const force = truthy(a.force);
  const interactive = process.stdin.isTTY && !truthy(a.yes);

  if (fs.existsSync(out) && !force) {
    if (!interactive) die(`${out} already exists — pass --force to overwrite`);
  }

  let cfg;
  if (!interactive) {
    cfg = { backend: "lmstudio", port: 8787, deviceName: os.hostname(), noSpeech: false };
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q, def) => {
      const ans = (await rl.question(`${q}${def !== undefined && def !== "" ? ` ${C.d}[${def}]${C.x}` : ""}: `)).trim();
      return ans || def || "";
    };
    const askBool = async (q, def) => (await ask(`${q} (y/n)`, def ? "y" : "n")).toLowerCase().startsWith("y");
    const askChoice = async (q, opts, def) => { let v; do { v = (await ask(`${q} (${opts.join("/")})`, def)).toLowerCase(); } while (!opts.includes(v)); return v; };

    if (fs.existsSync(out) && !force && !(await askBool(`${C.y}${out} exists — overwrite?${C.x}`, false))) { rl.close(); console.error("aborted."); return; }

    console.error(`\n${C.b}medpsy — interactive config${C.x} ${C.d}(Enter accepts the [default])${C.x}\n`);
    const backend = await askChoice("LLM backend", ["lmstudio", "qvac"], "lmstudio");
    const port = Number(await ask("API port", "8787")) || 8787;
    const profile = await ask(`Profile name ${C.d}(namespaces data + keys; blank = none)${C.x}`, "");
    const deviceName = await ask("Device / kiosk name", profile || os.hostname());
    const consultCode = await ask(`Mesh consult code ${C.d}(shared code to federate kiosks; blank = standalone)${C.x}`, "");
    let members = [];
    if (consultCode) {
      const m = await ask(`Authorized member pubkeys, comma-separated ${C.d}(blank = open mesh)${C.x}`, "");
      members = m.split(",").map((s) => s.trim()).filter(Boolean);
    }
    const noSpeech = await askBool("Disable on-device speech (STT/TTS)?", false);
    rl.close();
    cfg = {
      backend, port, deviceName, noSpeech,
      ...(profile ? { profile } : {}),
      ...(consultCode ? { consultCode } : {}),
      ...(members.length ? { members } : {}),
    };
  }

  fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
  const p = cfg.profile ? ` --profile ${cfg.profile}` : "";
  const mesh = cfg.consultCode ? `mesh "${cfg.consultCode}" (${cfg.members?.length ? `${cfg.members.length} member(s), enforced` : "open"})` : "standalone";
  console.error(`\n${C.g}✓ wrote ${out}${C.x} ${C.d}— ${cfg.backend} · :${cfg.port} · ${mesh}${cfg.noSpeech ? " · no speech" : ""}${C.x}`);
  console.error(`${C.b}next steps:${C.x}`);
  console.error(`  ${C.d}# create this device's signing key${C.x}`);
  console.error(`  node src/cli.js keygen${p}`);
  if (cfg.consultCode && cfg.members?.length)
    console.error(`  ${C.d}# membership enforced — collect each kiosk's key: node src/cli.js identity${p}, then sign a roster: node src/cli.js roster --code ${cfg.consultCode} --members <pubs>${C.x}`);
  console.error(`  ${C.d}# run the kiosk${C.x}`);
  console.error(`  npm run kiosk${p ? ` --${p}` : ""}`);
}

export function help() {
  console.log(`medpsy — local-first pharmacist triage CLI

usage: node src/cli.js <command> [options]   (or: medpsy <command>)

  triage "<complaint>"               one-shot triage + ICD grounding (default)
  init [-o file] [--force] [--yes]   interactive config scaffolder → medpsy.config.json
  keygen [--force]                   create/print this device's ed25519 signing key
  identity [--json]                  print this device's public key
  roster --code C --members a,b [--out f]   sign a membership roster (admin)
  export <encounterId> [out.json]    write a signed, tamper-evident audit bundle
  verify <bundle.json>               check a bundle's hash-chain + device signature
  import <bundle.json>               verify + store a received bundle (fails closed)
  help                               this text

global:  --profile <name>   --config <path>   (namespace state / load a config file)`);
}

export async function run(cmd, args) {
  const a = parseArgs(args);
  if (truthy(a.help)) return help();
  switch (cmd) {
    case "keygen": return keygen(a);
    case "identity": return identityCmd(a);
    case "roster": return rosterCmd(a);
    case "export": return exportCmd(a);
    case "verify": return verifyCmd(a);
    case "import": return importCmd(a);
    case "init": return init(a);
    default: help(); process.exit(1);
  }
}
