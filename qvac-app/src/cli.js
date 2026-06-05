#!/usr/bin/env node
// medpsy-qvac: local-first pharmacist triage with ICD-10 RAG grounding.
//   node src/cli.js "patient complaint ..."
// Flow: backend -> load models -> triage (medpsy) -> extract CONDITION ->
//       verify ICD-10 against the on-device index -> print grounded result.
import { getProvider } from "./backend.js";
import { triage } from "./triage.js";
import { loadOrBuildIndex, verifyIcd } from "./icd.js";
import { extractCondition, extractField, bandFor, extractIcdCode } from "./prompt.js";

const ANSI = { RED: "\x1b[91m", AMBER: "\x1b[93m", GREEN: "\x1b[92m", "": "" };
const DOT = { RED: "🔴", AMBER: "🟡", GREEN: "🟢", "": "⚪" };
const RESET = "\x1b[0m";

const complaint =
  process.argv.slice(2).join(" ") ||
  "I'm 58 and have had crushing central chest pressure for 40 minutes spreading to my jaw, I'm sweaty and breathless.";

const provider = await getProvider();
console.error(`Backend: ${provider.name}`);
await provider.init();

const index = await loadOrBuildIndex(provider, (d, t) => {
  if (d % 1280 === 0 || d === t) process.stderr.write(`\r  building ICD index ${d}/${t}`);
});
process.stderr.write("\n");

const raw = await triage(provider, complaint);
const condition = extractCondition(raw);
const [best] = condition ? await verifyIcd(condition, provider, index) : [null];
await provider.close();

const decision = extractField(raw, "DECISION");
const severity = extractField(raw, "SEVERITY"); // medpsy's 0-10 number
const band = bandFor(decision, severity);       // standard triage colour band
const sevNum = (String(severity).match(/\d+/) || [""])[0];

console.log("\n──────── PATIENT ────────");
console.log(complaint);
console.log(`\n──────── TRIAGE (medpsy)  ${DOT[band]} ${band} ────────`);
console.log(`${ANSI[band]}DECISION:   ${decision}     SEVERITY: ${sevNum}/10  [${band}]${RESET}`);
console.log(`RED FLAGS:  ${extractField(raw, "RED FLAGS")}`);
console.log(`CONDITION:  ${condition}`);
console.log(`ROUTING:    ${extractField(raw, "ROUTING")}`);
console.log(`SAFETY-NET: ${extractField(raw, "SAFETY-NET")}`);

console.log("\n──────── ICD-10 (verified on-device) ────────");
if (best) {
  const said = extractIcdCode(extractField(raw, "ICD-10"));
  console.log(`  ✅ ${best.code}  ${best.description}   [match ${best.score.toFixed(2)}]`);
  if (said && said.replace(".", "") !== best.code.replace(".", "")) {
    console.log(`  ⚠️  medpsy guessed ${said} — corrected to the verified code above`);
  }
} else {
  console.log("  (no condition extracted)");
}
