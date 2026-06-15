// Build a SIGNED membership roster (run by the clinic admin, signed with the admin's device
// key = the --profile's key). Hand the printed roster + the admin's pubkey to each kiosk; they
// accept it only if it verifies against that issuer. Clean stdout = the roster JSON.
//   npm run roster -- --profile admin --code CLINIC --members <pubA>,<pubB>,<pubC> [--out clinic-roster.json]
//   (admin's own pubkey: npm run identity -- --profile admin)
import "../src/bootstrap-config.js"; // honor --profile (the admin's signing key)
import fs from "node:fs";
const { signRoster } = await import("../src/roster.js");
const { getIdentity } = await import("../src/identity.js");

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return undefined; const v = args[i + 1]; return (v && !v.startsWith("--")) ? v : "true"; };

const code = flag("code") && flag("code") !== "true" ? flag("code") : "";
const members = (flag("members") && flag("members") !== "true" ? flag("members") : "").split(",").map((s) => s.trim()).filter(Boolean);
const roster = signRoster({ code, members });
const json = JSON.stringify(roster, null, 2);
const out = flag("out") && flag("out") !== "true" ? flag("out") : null;
if (out) { fs.writeFileSync(out, json); console.error(`[roster] wrote ${out}`); }
console.error(`[roster] issuer (admin) ${getIdentity().publicKey} — ${roster.members.length} member(s); kiosks set rosterIssuer to this key`);
console.log(out || json);
