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
import { getKbStatus, shareKb, joinKb, type KbStatus } from "../lib/kb";
import { getLearning, proposeEdge, vetEdge, promoteEdge, rejectEdge, drug, type Learning, type VetResult } from "../lib/learn";

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
  // P2P federation of the interaction graph (hyperswarm, no server).
  const [kb, setKb] = useState<KbStatus | null>(null);
  const [peerKey, setPeerKey] = useState("");
  const [kbMsg, setKbMsg] = useState("");
  const refreshKb = () => getKbStatus().then(setKb);
  // Edge-learning loop.
  const [learn, setLearn] = useState<Learning | null>(null);
  const [teach, setTeach] = useState({ a: "", b: "", severity: "major", note: "" });
  const [verdicts, setVerdicts] = useState<Record<string, VetResult | "vetting">>({});
  const refreshLearn = () => getLearning().then(setLearn);

  async function doTeach() {
    if (!teach.a.trim() || !teach.b.trim()) return;
    await proposeEdge(teach);
    setTeach({ a: "", b: "", severity: "major", note: "" });
    refreshLearn();
  }
  async function doVet(id: string) {
    setVerdicts((v) => ({ ...v, [id]: "vetting" }));
    const r = await vetEdge(id);
    setVerdicts((v) => ({ ...v, [id]: r || { local: { real: false, reason: "vet failed" } } }));
    refreshLearn();
  }
  async function doPromote(id: string, severity?: string) { await promoteEdge(id, severity); refreshLearn(); loadFacts(log); }
  async function doReject(id: string) { await rejectEdge(id); refreshLearn(); }

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
  useEffect(() => { refreshKb(); refreshLearn(); }, []);

  async function doShare() {
    setKbMsg("starting…");
    const r = await shareKb();
    setKbMsg(r?.key ? "Sharing — give this key to a peer kiosk." : "share failed");
    refreshKb();
  }
  async function doJoin() {
    const key = peerKey.trim();
    if (!/^[0-9a-f]{64}$/i.test(key)) { setKbMsg("Enter the 64-hex key from the sharing kiosk."); return; }
    setKbMsg("joining over hyperswarm (discovery ~5–15 s)…");
    const r = await joinKb(key);
    setKbMsg(r?.joined ? `Joined — merged ${r.imported} edge(s); graph now ${r.total}.` : `join: ${r?.error || r?.reason || "failed"}`);
    setPeerKey(""); refreshKb(); loadFacts(log);
  }

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

      {/* Live P2P federation of the interaction graph — hyperswarm, no server. */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>🔗 Federate (P2P) <span className="badge">no server</span></h2>
        <p className="note">Share this kiosk's interaction graph with another kiosk, or join a peer's, over an
          encrypted device-to-device link (hyperswarm). The agent grounds on the merged graph — including a peer's
          live updates. No cloud, no central database.</p>
        <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn ghost" onClick={doShare}>📡 Share this graph</button>
          {kb?.sharing && kb.key && (
            <code className="mono" title="give this to a peer kiosk" style={{ wordBreak: "break-all", fontSize: 12 }}>{kb.key}</code>
          )}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input value={peerKey} placeholder="Paste a peer's 64-hex key…" onChange={(e) => setPeerKey(e.target.value)} style={{ flex: 1 }} />
          <button className="btn" onClick={doJoin} disabled={!peerKey.trim()}>🔌 Join peer</button>
        </div>
        <p className="note" style={{ marginTop: 8 }}>
          {kb ? `graph: ${kb.count} edges · ${kb.peers.length} peer(s) joined${kb.sharing ? " · sharing" : ""}` : "loading…"}
          {kbMsg && ` — ${kbMsg}`}
        </p>
      </div>

      {/* Edge-learning loop: propose → adversarial vet → promote into the grounded graph. */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>🧠 Learn (edge proposals) <span className="badge">on-device · PHI-free</span></h2>
        <p className="note">Teach the network a drug interaction. It's adversarially vetted by medpsy, then a
          clinician promotes it into the grounded, federated graph — with a tamper-evident provenance trail.
          Only two drug names + a note ever leave; never a patient.</p>

        <div className="row" style={{ flexWrap: "wrap", alignItems: "center" }}>
          <input value={teach.a} placeholder="drug A" onChange={(e) => setTeach({ ...teach, a: e.target.value })} style={{ width: 120 }} />
          <span className="note">+</span>
          <input value={teach.b} placeholder="drug B" onChange={(e) => setTeach({ ...teach, b: e.target.value })} style={{ width: 120 }} />
          <select value={teach.severity} onChange={(e) => setTeach({ ...teach, severity: e.target.value })}>
            <option value="major">major</option><option value="moderate">moderate</option><option value="minor">minor</option>
          </select>
          <input value={teach.note} placeholder="mechanism / note" onChange={(e) => setTeach({ ...teach, note: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
          <button className="btn" onClick={doTeach} disabled={!teach.a.trim() || !teach.b.trim()}>Propose</button>
        </div>

        {learn && learn.pending.length > 0 && (
          <ul className="kb-facts" style={{ marginTop: 10 }}>
            {learn.pending.map((c) => {
              const v = verdicts[c.id];
              return (
                <li key={c.id} className="kb-fact">
                  <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
                    <span className="pill AMBER">candidate</span>{" "}
                    <span className="mono">{drug(c.a)} + {drug(c.b)}</span>{" "}
                    <span className={`pill ${c.severity === "major" ? "RED" : "AMBER"}`}>{c.severity}</span>
                    {c.note && <span className="note"> · {c.note}</span>}
                    <span style={{ flex: 1 }} />
                    <button className="btn ghost" onClick={() => doVet(c.id)} disabled={v === "vetting"}>{v === "vetting" ? "vetting…" : "🔬 Vet"}</button>
                    <button className="btn ghost" onClick={() => doPromote(c.id, typeof v === "object" ? v.local.severity : undefined)}>✓ Promote</button>
                    <button className="btn ghost" onClick={() => doReject(c.id)}>✕ Reject</button>
                  </div>
                  {typeof v === "object" && (
                    <div className="note" style={{ marginTop: 4 }}>
                      <span>this kiosk: <span className={`pill ${v.local.real ? "GREEN" : "RED"}`}>{v.local.real ? "REAL" : "REFUTED"}</span>{v.local.severity ? ` (${v.local.severity})` : ""} — {v.local.reason}</span>
                      {v.peer && !v.peer.error && (
                        <div>peer {v.peer.by} {v.peer.signatureOk ? "✓" : "✗sig"}: <span className={`pill ${v.peer.real ? "GREEN" : "RED"}`}>{v.peer.real ? "REAL" : "REFUTED"}</span>{v.peer.severity ? ` (${v.peer.severity})` : ""} — {v.peer.reason}</div>
                      )}
                      {v.peer?.error && <div>peer vet: {v.peer.error}</div>}
                    </div>
                  )}
                  {(c.contributedBy || c.votes.length > 0) && (
                    <div className="note">{c.contributedBy ? `contributed by ${c.contributedBy} · ` : ""}{c.votes.length} vote(s){c.votes.length ? `: ${c.votes.filter((vo) => vo.real).length} real / ${c.votes.length}` : ""}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {learn && <p className="note" style={{ marginTop: 6 }}>{learn.pending.length} candidate(s) · {learn.promoted.length} learned edge(s) promoted into the graph</p>}
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
