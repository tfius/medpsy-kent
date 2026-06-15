// Print a kiosk's device public key (honoring --profile) — so you can build the membership
// allowlist for medpsy.config.json without starting the server. Clean stdout = just the key.
//   npm run identity -- --profile clinic-b
//   npm run identity -- --profile clinic-b --json
import "../src/bootstrap-config.js"; // honor --profile (sets MEDPSY_DEVICE_KEY_FILE)
const { getIdentity } = await import("../src/identity.js");
const id = getIdentity();
console.log(process.argv.includes("--json") ? JSON.stringify(id) : id.publicKey);
