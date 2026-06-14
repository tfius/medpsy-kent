// Knowledge base — the pharmacist panel for the on-device clinical knowledge LAYER
// (factstore kb:* logs; e.g. kb:medical, the authored drug-interaction graph) and its OKF
// (Open Knowledge Format) interchange: export the graph as a directory of markdown concept
// docs for Google's OKF ecosystem, and import an OKF bundle back in.
//
// Clinician-facing (reference knowledge, not PHI) — stays English.
import { useEffect, useRef, useState } from "react";
import {
  listKnowledgeLogs, getFacts, exportKnowledgeOKF, importKnowledgeOKF,
  filesToOkfBundle, downloadOkfBundle, type Fact,
} from "../lib/okf";

const objText = (o: unknown): string =>
  o && typeof o === "object"
    ? ("ref" in (o as Record<string, unknown>) ? String((o as { ref: unknown }).ref) : JSON.stringify(o))
    : String(o);

export default function Knowledge() {
  const [logs, setLogs] = useState<string[]>([]);
  const [log, setLog] = useState<string>("");
  const [facts, setFacts] = useState<Fact[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const dirRef = useRef<HTMLInputElement>(null);

  // A directory <input> needs the non-standard webkitdirectory attribute (not in React's
  // types) — set it on the element so the picker selects an OKF folder, not a single file.
  useEffect(() => {
    const el = dirRef.current;
    if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); }
  }, []);

  useEffect(() => {
    listKnowledgeLogs().then((ls) => {
      setLogs(ls);
      setLog((cur) => cur || (ls.includes("kb:medical") ? "kb:medical" : ls[0] || ""));
    });
  }, []);

  const loadFacts = (l: string) => { if (l) getFacts(l).then(setFacts); };
  useEffect(() => { loadFacts(log); }, [log]);

  async function doExport() {
    if (!log) return;
    setBusy(true); setMsg("");
    const r = await exportKnowledgeOKF(log);
    setBusy(false);
    if (!r) { setMsg("export failed (is the API server running?)"); return; }
    downloadOkfBundle(log.replace(/[^a-z0-9]+/gi, "-"), r.files);
    setMsg(`Exported ${r.count} OKF file(s) → wrote ${r.dir} (and downloaded the bundle).`);
  }

  async function doImport(fileList: FileList) {
    if (!log) return;
    setBusy(true); setMsg("");
    const bundle = await filesToOkfBundle(fileList);
    const n = Object.keys(bundle).length;
    if (!n) { setBusy(false); setMsg("No .md files found in that folder."); return; }
    const r = await importKnowledgeOKF(log, bundle);
    setBusy(false);
    if (!r) { setMsg("import failed (server error)"); return; }
    setMsg(`Imported ${r.imported} fact(s) from ${n} OKF doc(s) into ${log}.`);
    loadFacts(log);
    listKnowledgeLogs().then(setLogs);
  }

  return (
    <>
      <div className="eyebrow">Knowledge <span className="badge">OKF</span></div>
      <h1>Knowledge base</h1>
      <p className="lead">The on-device clinical knowledge graph (drug interactions, authored references).
        Export it as <strong>OKF</strong> — a portable directory of markdown concept docs — for Google's
        Open Knowledge Format ecosystem, or import an OKF bundle back in.</p>

      <p className="note" style={{ borderLeft: "3px solid var(--amber, #c80)", paddingLeft: 8 }}>
        ⚠️ OKF is <strong>lossy interchange</strong>: typed edges (e.g. <code>interacts_with</code>) flatten to
        OKF's untyped links and import back as <code>links_to</code>. For the lossless, tamper-evident record,
        use the signed factstore bundle (the audit/export paths) — OKF is for sharing, not the source of truth.
      </p>

      <div className="card">
        <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <label htmlFor="kblog">Knowledge log</label>
          <select id="kblog" value={log} onChange={(e) => setLog(e.target.value)}>
            {logs.length === 0 && <option value="">(none)</option>}
            {logs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <span className="note">{facts.length} fact(s)</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={doExport} disabled={!log || busy}>⬇ Export OKF</button>
          <button className="btn ghost" onClick={() => dirRef.current?.click()} disabled={!log || busy}>⬆ Import OKF…</button>
          <input ref={dirRef} type="file" multiple style={{ display: "none" }}
            onChange={(e) => { const fs = e.target.files; if (fs && fs.length) doImport(fs); e.currentTarget.value = ""; }} />
        </div>
        {msg && <p className="note" style={{ marginTop: 8 }}>{msg}</p>}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Facts</h2>
        {facts.length === 0 ? (
          <p className="note">No facts in this log.</p>
        ) : (
          <ul className="kb-facts">
            {facts.map((f, i) => {
              const sev = f.meta?.severity as string | undefined;
              const note = f.meta?.note as string | undefined;
              return (
                <li key={i} className="kb-fact">
                  <span className="mono">{f.subject}</span>
                  {" "}<span className="note">—{f.predicate}→</span>{" "}
                  <span className="mono">{objText(f.object)}</span>
                  {sev && <span className={`pill ${sev === "major" ? "RED" : "AMBER"}`} style={{ marginLeft: 6 }}>{sev}</span>}
                  {note && <span className="note"> · {note}</span>}
                  <span className="note" style={{ marginLeft: 6 }}>[{f.source}]</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
