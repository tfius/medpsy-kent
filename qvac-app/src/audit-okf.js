// Lossy OKF (Open Knowledge Format) VIEW of an audit encounter — a human-readable
// rendering for the OKF ecosystem (visualizer/catalog), NOT the audit record.
//
// ⚠️ NON-AUTHORITATIVE BY DESIGN. The authoritative, tamper-evident record is the signed
// `medpsy-audit` bundle (src/audit.js exportBundle: full hash chain + ed25519 device
// signature). OKF is plain markdown with no hash chain, no per-event provenance, no
// signature — flattening an encounter to OKF DROPS exactly the properties that make the
// audit trustworthy. This view exists so a reviewer can read/visualize an encounter in
// OKF tooling; the frontmatter states the loss and points back to the signed bundle.
//
//   encounterToOKF(encounterId) -> { "index.md", "encounter/<id>.md", "concept/<dx>.md"? }
import * as audit from "./audit.js";

// One-line, human-readable gloss of an event for the OKF timeline (mirrors the audit
// viewer's summaries; kept deliberately short — full data lives in the signed bundle).
function glossOf(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "encounter.start": return `lang=${d.lang ?? "?"}`;
    case "stage.enter": return String(d.name || d.path || "");
    case "patient": return `${d.name ?? "?"} (${d.id ?? "?"})`;
    case "consent": return `understood=${d.understood}`;
    case "message.user": return q(d.text);
    case "message.assistant": return q(d.text);
    case "stt": return `“${d.text}” (${d.lang ?? ""})`;
    case "tts": return `“${clip(d.text)}” [${d.voice ?? ""}]`;
    case "translation": return `${d.from}→${d.to}`;
    case "icd": return `${d.condition} → ${d.verified} ${d.description ?? ""}`;
    case "knowledge.search": return clip(d.query);
    case "atriage.reasoning": return clip(d.text);
    case "atriage.tool": return `${d.name}(${Object.values(d.args || {}).map(String).join(", ").slice(0, 40)})`;
    case "atriage.tool_result": return `${d.name} → ${clip(JSON.stringify(d.result))}`;
    case "atriage.error": return clip(d.error);
    case "agent.tool": return `${d.name}(${Object.values(d.args || {}).map(String).join(", ").slice(0, 40)})`;
    case "agent.answer": return clip(d.text);
    case "facts.read": return `${d.tool} → ${(d.statements || []).length} fact(s)`;
    case "facts.assert": return `${d.tool ?? ""} ${d.predicate ?? ""} ${clip(JSON.stringify(d.object))}`.trim();
    case "outcome": return `${d.decision ?? ""} ${d.band ?? ""} · ${d.condition ?? ""} ${d.icd ?? ""}`.trim();
    case "signoff": return `${d.validatedBy ?? ""} · ${d.decision ?? ""}`;
    case "note": return clip(d.text);
    default: return clip(JSON.stringify(d));
  }
}
const clip = (s, n = 100) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const q = (s) => `“${clip(s)}”`;

function yamlScalar(v) {
  const s = String(v);
  return /[:#[\]{},]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";

// Render one OKF concept doc (frontmatter + body sections).
function doc(front, sections) {
  let out = "---\n";
  for (const [k, v] of Object.entries(front)) out += `${k}: ${yamlScalar(v)}\n`;
  out += "---\n";
  for (const [heading, lines] of sections) {
    if (!lines.length) continue;
    out += `\n# ${heading}\n\n${lines.join("\n")}\n`;
  }
  return out;
}

export function encounterToOKF(encounterId) {
  const events = audit.read(encounterId);
  if (!events.length) return null;
  const integrity = audit.verify(events);
  const last = (t) => events.filter((e) => e.type === t).slice(-1)[0]?.data;
  const patient = last("patient");
  const outcome = last("outcome") || last("signoff");
  const files = {};

  // The encounter concept: frontmatter facts + the full event timeline + a link to the
  // working-diagnosis concept (if any).
  const id = encounterId;
  const front = {
    type: "Encounter", title: id, encounterId: id,
    started: events[0].ts, ended: events[events.length - 1].ts, events: events.length,
    integrity: integrity.ok ? "ok" : `broken@${integrity.brokenAt}`,
    authoritative: "false",
    note: "Human-readable OKF VIEW — NOT the audit record. Tamper-evidence lives in the signed medpsy-audit bundle (/api/audit/<id>/export).",
    okf_version: "0.1",
  };
  if (patient?.name) front.patient = patient.name;
  if (outcome?.decision) { front.decision = outcome.decision; front.band = outcome.band || ""; }

  const timeline = events.map((ev) => {
    const g = glossOf(ev);
    return `- **#${ev.seq}** \`${ev.type}\` _(${ev.actor})_${g ? ` — ${g}` : ""}`;
  });
  const related = [];
  let dxId = null;
  if (outcome?.condition) {
    dxId = `concept/${slug(outcome.icd || outcome.condition)}`;
    related.push(`- working_diagnosis: [${outcome.condition}](/${dxId}.md)`);
    // A small condition concept so the OKF graph has the encounter → diagnosis edge.
    files[`${dxId}.md`] = doc(
      { type: "Condition", title: outcome.condition, icd: outcome.icd || "", okf_version: "0.1" },
      [["Facts", [
        outcome.icd ? `- **icd10**: ${outcome.icd}` : "",
        outcome.decision ? `- **triage_decision**: ${outcome.decision}` : "",
        outcome.band ? `- **band**: ${outcome.band}` : "",
        outcome.redFlags ? `- **red_flags**: ${clip(outcome.redFlags, 200)}` : "",
      ].filter(Boolean)]],
    );
  }
  files[`encounter/${id}.md`] = doc(front, [["Timeline", timeline], ["Related", related]]);

  // OKF index.
  let index = doc({ type: "Index", title: `audit:${id}`, authoritative: "false", okf_version: "0.1" }, []);
  index += `\n# Concepts\n\n- [${id}](/encounter/${id}.md)\n`;
  if (dxId && outcome?.condition) index += `- [${outcome.condition}](/${dxId}.md)\n`;
  files["index.md"] = index;
  return files;
}
