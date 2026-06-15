#!/usr/bin/env node
// medpsy — local-first pharmacist triage CLI.
//   medpsy "<complaint>"            one-shot triage + ICD grounding (default; back-compat)
//   medpsy <subcommand> [options]   init | keygen | identity | roster | export | verify | import | help
// bootstrap-config.js runs FIRST so --profile / --config set env before identity/audit load.
import "./bootstrap-config.js";

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const SUBCOMMANDS = new Set(["keygen", "identity", "init", "verify", "import", "export", "roster", "help"]);

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  (await import("./cli-commands.js")).help();
} else if (cmd && SUBCOMMANDS.has(cmd)) {
  await (await import("./cli-commands.js")).run(cmd, rest);
} else {
  // No subcommand → treat the args as a triage complaint (so `medpsy "chest pain…"` and the
  // old `node src/cli.js "…"` / `npm run triage` keep working). `triage` prefix also accepted.
  await runTriage(cmd === "triage" ? rest : argv);
}

async function runTriage(args) {
  const { getProvider } = await import("./backend.js");
  const { triage } = await import("./triage.js");
  const { loadOrBuildIndex, verifyIcd } = await import("./icd-index.js");
  const { extractCondition, extractField, bandFor, extractIcdCode } = await import("./prompt.js");

  const ANSI = { RED: "\x1b[91m", AMBER: "\x1b[93m", GREEN: "\x1b[92m", "": "" };
  const DOT = { RED: "🔴", AMBER: "🟡", GREEN: "🟢", "": "⚪" };
  const RESET = "\x1b[0m";

  const complaint = args.join(" ") ||
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
  const severity = extractField(raw, "SEVERITY");
  const band = bandFor(decision, severity);
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
}
