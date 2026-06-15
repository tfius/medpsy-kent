// Federated safety-intelligence demo — PHI-free pharmacovigilance across the mesh. Each kiosk
// privately tallies how often a drug PAIR co-occurs and how often a concern is flagged (integers
// only, never patient data). Log a few encounters across DIFFERENT kiosks: no single kiosk has
// enough to act, but the NETWORK aggregate climbs and crosses a threshold — then "Scan" turns the
// emergent signal into a candidate in the human-gated learning loop, which (once promoted) every
// kiosk grounds on. Talks to each kiosk by absolute URL (CORS).
import { useEffect, useState } from "react";
import { kiosk, type SignalStatus } from "../lib/kiosk";
import { drug } from "../lib/learn";

const DEFAULT_URLS = ["http://localhost:8787", "http://localhost:8788", "http://localhost:8789"];
// Plausible pairs NOT in the seeded graph — so the network "discovers" them from co-occurrence.
const SCENARIOS = [
  { a: "citalopram", b: "domperidone", label: "additive QT prolongation" },
  { a: "duloxetine", b: "tamoxifen", label: "CYP2D6 — reduced tamoxifen activation" },
  { a: "omeprazole", b: "clopidogrel", label: "CYP2C19 — reduced antiplatelet effect" },
];

export default function SignalsDemo() {
  const [urls, setUrls] = useState(DEFAULT_URLS);
  const [sc, setSc] = useState(0);
  const pair = SCENARIOS[sc];
  const [sig, setSig] = useState<Record<number, SignalStatus | null>>({});
  const [logs, setLogs] = useState<Record<number, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const K = urls.map((u) => kiosk(u));
  const log = (i: number, t: string) => setLogs((l) => ({ ...l, [i]: [...(l[i] || []), t] }));

  // Live: poll each kiosk's network signal view (it sums self + meshed peers).
  useEffect(() => {
    let on = true;
    const tick = () => urls.forEach((u, i) => kiosk(u).signals().then((s) => { if (on) setSig((x) => ({ ...x, [i]: s })); }));
    tick(); const t = setInterval(tick, 2500);
    return () => { on = false; clearInterval(t); };
  }, [urls.join(",")]);

  // Row for THIS scenario's pair from a kiosk's aggregate.
  const rowOf = (s: SignalStatus | null) => s?.aggregate.find((r) => r.a.includes(pair.a) && r.b.includes(pair.b) || r.a.includes(pair.b) && r.b.includes(pair.a)) || null;
  const crosses = (s: SignalStatus | null) => !!s?.crossing.find((r) => r.a.includes(pair.a) && r.b.includes(pair.b) || r.a.includes(pair.b) && r.b.includes(pair.a));
  const thr = sig[0]?.threshold;

  async function observe(i: number, adverse: boolean) {
    setBusy(true);
    try {
      await K[i].observeSignal(pair.a, pair.b, adverse);
      log(i, `${adverse ? "⚠️ encounter — concern flagged" : "· encounter — no concern"} (${pair.a}+${pair.b})`);
      const s = await K[i].signals(); setSig((x) => ({ ...x, [i]: s }));
    } finally { setBusy(false); }
  }

  // Drive the whole story: spread a handful of flagged encounters across the kiosks so the
  // NETWORK crosses the threshold even though no single kiosk would.
  async function seedAcross() {
    setBusy(true); setLogs({}); setMsg("");
    try {
      const plan: [number, boolean][] = [[0, true], [1, true], [0, false], [2, true], [1, true]];
      for (const [i, adv] of plan) { if (i < urls.length) await observe(i, adv); }
      setMsg("Logged across kiosks — watch each kiosk's NETWORK total cross the threshold (no single kiosk did).");
    } finally { setBusy(false); }
  }

  async function scanPropose(i: number) {
    setBusy(true);
    try {
      const r = await K[i].scanSignals();
      if (r?.proposed?.length) {
        for (const p of r.proposed) log(i, `📡 signal crossed → proposed ${drug(p.a)}+${drug(p.b)} (${p.severity}, ${p.flagged}/${p.seen} across ${p.contributors})`);
        setMsg(`Kiosk ${String.fromCharCode(65 + i)} turned the federated signal into a candidate — now in the learning loop (vet → promote on the Mesh/Learn view).`);
      } else log(i, "nothing crossing yet (need ≥2 kiosks, enough flagged, high enough rate)");
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="eyebrow">Demo <span className="badge">federated safety intelligence</span></div>
      <h1>The network spots a signal no single kiosk could</h1>
      <p className="lead">Each kiosk privately counts how often a drug pair co-occurs and how often a concern is
        flagged — integers only, never patient data. Spread a few encounters across kiosks: individually they're
        noise, but the <strong>network aggregate</strong> crosses a threshold and auto-proposes a candidate into
        the human-gated learning loop. Federated pharmacovigilance, fully on-device.</p>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", alignItems: "center" }}>
          <strong>Watch pair:</strong>
          {SCENARIOS.map((s, i) => <button key={i} className={`btn ghost${i === sc ? " active" : ""}`} onClick={() => { setSc(i); setLogs({}); setMsg(""); }} disabled={busy}>{s.a}+{s.b}</button>)}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={seedAcross} disabled={busy}>{busy ? "logging…" : "▶ Log encounters across the mesh"}</button>
        </div>
        <p className="note" style={{ marginTop: 6 }}>{pair.a} + {pair.b} — <em>{pair.label}</em>.
          Threshold: ≥{thr?.minContributors ?? 2} kiosks · ≥{thr?.minFlagged ?? 3} flagged · rate ≥{thr?.minRate ?? 0.3}.</p>
        {msg && <p className="note">{msg}</p>}
      </div>

      <div className="row" style={{ gap: 12, alignItems: "stretch", flexWrap: "wrap" }}>
        {urls.map((u, i) => {
          const s = sig[i]; const r = rowOf(s); const hot = crosses(s);
          return (
            <div key={i} className="card" style={{ flex: "1 1 260px", borderTop: `3px solid ${hot ? "var(--green)" : "var(--amber)"}` }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ margin: 0 }}>Kiosk {String.fromCharCode(65 + i)}</h2>
                <span className={`pill ${hot ? "GREEN" : r ? "AMBER" : ""}`}>{hot ? "signal ✓" : r ? "watching" : "—"}</span>
              </div>
              <p className="note">network total (self + {s ? (s.contributors - 1) : 0} peers):</p>
              <div className="row" style={{ gap: 14, alignItems: "baseline" }}>
                <span><strong style={{ fontSize: 22 }}>{r?.flagged ?? 0}</strong>/{r?.seen ?? 0}<span className="note"> flagged/seen</span></span>
                <span><strong style={{ fontSize: 22 }}>{r?.contributors ?? 0}</strong><span className="note"> kiosks</span></span>
                <span><strong style={{ fontSize: 22 }}>{r ? Math.round(r.rate * 100) : 0}%</strong><span className="note"> rate</span></span>
              </div>
              <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: "wrap" }}>
                <button className="btn ghost" onClick={() => observe(i, true)} disabled={busy} title="Record an encounter where a concern was flagged">⚠️ +concern</button>
                <button className="btn ghost" onClick={() => observe(i, false)} disabled={busy}>· +no concern</button>
                <button className="btn ghost" onClick={() => scanPropose(i)} disabled={busy} title="Turn a crossed signal into a candidate edge">📡 scan → propose</button>
              </div>
              <input value={u} onChange={(e) => setUrls(urls.map((x, j) => j === i ? e.target.value : x))} style={{ width: "100%", fontSize: 11, marginTop: 6 }} />
              <ol className="audit-timeline" style={{ marginTop: 6 }}>
                {(logs[i] || []).map((t, k) => <li key={k} className="audit-ev"><div className="audit-ev-sum">{t}</div></li>)}
                {!(logs[i] || []).length && <p className="note">—</p>}
              </ol>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ borderLeft: "3px solid var(--green)" }}>
        <strong>🔒 What crosses the mesh:</strong> a drug pair <span className="pill GREEN">{pair.a}</span> + <span className="pill GREEN">{pair.b}</span>
        <span className="note"> and two integers (times seen, times a concern was flagged). <strong>Patient data: none.</strong>
          The candidate it raises still goes through the same human vet → promote gate before any kiosk grounds on it.</span>
      </div>
    </>
  );
}
