// Interop with Google's Open Knowledge Format (OKF v0.1) — a directory of markdown files
// with YAML frontmatter, where markdown links are untyped edges. OKF is the portable
// *interchange* format for the REFERENCE-KNOWLEDGE layer (clinical protocols, drug
// monographs, the authored interaction graph — a kb:* log), NOT for PHI patient logs
// (OKF has no valid-time / provenance-per-fact / tamper-evidence). The factstore stays
// the queryable, bi-temporal engine; OKF is how a reference log travels to/from the wider
// ecosystem (the OKF visualizer, catalog, other agents).
//
// Lossy by design in the OKF direction: the factstore's TYPED edges (e.g. interacts_with)
// flatten to OKF's UNTYPED links — OKF carries relationship meaning in prose, not the link.
// Importing back, links become a generic `links_to` ref edge.
//
//   exportOKF(store, { log }) -> { "<conceptId>.md": "<markdown>", ..., "index.md": ... }
//   importOKF(files, store, { log }) -> asserts facts (source:"okf")

// Predicates that map to OKF frontmatter rather than body facts.
const FRONT_KEYS = new Set(["type", "title", "description", "resource", "tags"]);

const subjectToPath = (s) => s.replace(/:/g, "/");
const pathToSubject = (p) => p.replace(/\//g, ":");

function yamlScalar(v) {
  if (Array.isArray(v)) return "[" + v.map(yamlScalar).join(", ") + "]";
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return /[:#[\]{},]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

function renderDoc(front, literals, links) {
  let out = "---\n";
  for (const [k, v] of Object.entries(front)) out += `${k}: ${yamlScalar(v)}\n`;
  out += "---\n";
  if (literals.length) {
    out += "\n# Facts\n\n";
    for (const l of literals) out += `- **${l.predicate}**: ${typeof l.value === "object" ? JSON.stringify(l.value) : l.value}\n`;
  }
  if (links.length) {
    out += "\n# Related\n\n";
    for (const e of links) out += `- ${e.predicate}: [${e.to}](/${subjectToPath(e.to)}.md)\n`;
  }
  return out;
}

// Export the current facts of one log as an OKF bundle (one concept doc per subject).
export async function exportOKF(store, { log, validAt, knownAt } = {}) {
  const { facts } = await store.fold(log, { validAt, knownAt });
  const bySubject = new Map();
  for (const f of facts) {
    if (!bySubject.has(f.subject)) bySubject.set(f.subject, []);
    bySubject.get(f.subject).push(f);
  }
  const files = {};
  const concepts = [];
  for (const [subject, list] of bySubject) {
    const conceptId = subjectToPath(subject);
    const front = { type: "Concept" };
    const literals = [], links = [];
    let timestamp = null;
    for (const f of list) {
      if (f.recordedAt && (!timestamp || f.recordedAt > timestamp)) timestamp = f.recordedAt;
      const ref = f.object && typeof f.object === "object" ? f.object.ref : undefined;
      if (ref) links.push({ predicate: f.predicate, to: ref });
      else if (FRONT_KEYS.has(f.predicate)) front[f.predicate] = f.object;
      else literals.push({ predicate: f.predicate, value: f.object });
    }
    if (!front.title) front.title = subject.split(":").pop();
    if (timestamp) front.timestamp = timestamp;
    files[conceptId + ".md"] = renderDoc(front, literals, links);
    concepts.push({ conceptId, title: front.title });
  }
  let index = `---\ntype: Index\ntitle: ${log}\nokf_version: "0.1"\n---\n\n# ${log}\n\n`;
  for (const c of concepts) index += `- [${c.title}](/${c.conceptId}.md)\n`;
  files["index.md"] = index;
  return files;
}

function parseFront(content) {
  const m = content.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); // tolerate CRLF
  if (!m) return { front: {}, body: content };
  const unquote = (s) => ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s);
  const front = {};
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([\w-]+):\s*(.*)$/);
    if (!mm) continue;
    const [, k, raw] = mm; const v = raw.trim();
    if (v.startsWith("[") && v.endsWith("]")) front[k] = v.slice(1, -1).split(",").map((x) => unquote(x.trim())).filter(Boolean);
    else front[k] = unquote(v);
  }
  return { front, body: m[2] };
}

// Import an OKF bundle as reference facts (source:"okf"). Frontmatter -> attribute facts;
// markdown links -> untyped `links_to` ref edges (OKF links carry no type).
export async function importOKF(files, store, { log, source = "okf", actor = "system" } = {}) {
  let imported = 0;
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".md") || path === "index.md" || path.endsWith("/index.md") || path === "log.md") continue;
    const conceptId = path.slice(0, -3);
    const subject = pathToSubject(conceptId);
    const { front, body } = parseFront(content);
    const meta = { ref: conceptId, schema: "okf" };
    // Deterministic statementIds make re-importing an updated bundle an UPSERT (latest
    // assert wins in fold), not a duplicate — required for an "updatable shared KB".
    for (const k of FRONT_KEYS) {
      if (front[k] !== undefined) { await store.assert(log, { statementId: `okf:${conceptId}#${k}`, subject, predicate: k, object: front[k], source, actor, meta }); imported++; }
    }
    for (const mm of body.matchAll(/\[[^\]]*\]\((\.?\/[^)]+\.md)\)/g)) {
      const target = pathToSubject(mm[1].replace(/^\.?\//, "").replace(/\.md$/, ""));
      await store.assert(log, { statementId: `okf:${conceptId}#links_to#${target}`, subject, predicate: "links_to", object: { ref: target }, source, actor, meta });
      imported++;
    }
  }
  return { imported };
}
