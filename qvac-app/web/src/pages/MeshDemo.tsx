// Mesh demo — N kiosks side by side (default 3). Teach a missed interaction on ANY kiosk and
// watch the OTHERS light up "flags it: NO → YES" as the lesson federates (live, ~1 s), jury and
// all. Optionally enforce production-grade MEMBERSHIP: allowlist these kiosks' device keys so
// only authorized kiosks may join the mesh + vote. Talks to each kiosk by absolute URL (CORS).
import { useEffect, useState } from "react";
import { kiosk, type KioskBackend } from "../lib/kiosk";
import { drug } from "../lib/learn";

const DEFAULT_URLS = ["http://localhost:8787", "http://localhost:8788", "http://localhost:8789"];
const SCENARIOS = [
  { a: "amiodarone", b: "simvastatin", correction: "Overrode triage — amiodarone + simvastatin: amiodarone inhibits CYP3A4, raising simvastatin to myopathy/rhabdomyolysis risk. MAJOR, missed." },
  { a: "clarithromycin", b: "ergotamine", correction: "Missed: clarithromycin (CYP3A4 inhibitor) + ergotamine → ergotism/vasospasm. Major." },
  { a: "fluconazole", b: "phenytoin", correction: "Overrode — fluconazole inhibits CYP2C9, raising phenytoin toward toxicity. Major, missed." },
];
type G = "?" | "no" | "yes";

export default function MeshDemo() {
  const [urls, setUrls] = useState(DEFAULT_URLS);
  const [teachOn, setTeachOn] = useState(0);
  const [sc, setSc] = useState(0);
  const [edit, setEdit] = useState(SCENARIOS[0]);
  const [ground, setGround] = useState<Record<number, G>>({});
  const [logs, setLogs] = useState<Record<number, string[]>>({});
  const [status, setStatus] = useState<Record<number, KioskBackend | null>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const K = urls.map((u) => kiosk(u));
  const log = (i: number, t: string) => setLogs((l) => ({ ...l, [i]: [...(l[i] || []), t] }));
  const setG = (i: number, g: G) => setGround((x) => ({ ...x, [i]: g }));
  function reset(i = sc) { setSc(i); setEdit(SCENARIOS[i]); setLogs({}); setGround({}); setMsg(""); }

  // Live status row: each kiosk's connected peers + membership.
  useEffect(() => {
    let on = true;
    const tick = () => urls.forEach((u, i) => kiosk(u).backend().then((b) => { if (on) setStatus((s) => ({ ...s, [i]: b })); }));
    tick(); const t = setInterval(tick, 4000);
    return () => { on = false; clearInterval(t); };
  }, [urls.join(",")]);

  async function run() {
    setBusy(true); setLogs({}); setMsg("");
    try {
      await Promise.all(K.map(async (k, i) => { const c = await k.check(edit.a, edit.b); setG(i, c ? (c.grounded ? "yes" : "no") : "?"); }));
      const T = K[teachOn];
      const d = await T.distill(edit.correction);
      let id = d?.proposed?.[0]?.id || null;
      if (!id) id = (await T.learn())?.pending.find((c) => `${c.a}${c.b}`.includes(edit.b.toLowerCase()))?.id || (await T.learn())?.pending.slice(-1)[0]?.id || null;
      log(teachOn, d?.proposed?.length ? `🧪 distilled ${edit.a}+${edit.b} (candidate)` : "nothing new (already known?)");
      if (!id) { setMsg("nothing to teach (already in the graph?) — try another scenario"); return; }
      const v = await T.vet(id);
      if (v?.local) {
        log(teachOn, `🔬 jury — me: ${v.local.real ? "REAL" : "REFUTED"}`);
        for (const p of v.peers || []) log(teachOn, `🔬 jury — ${p.by} ${p.signatureOk ? "✓" : "✗"}: ${p.real ? "REAL" : "REFUTED"}`);
        if (!v.peers?.length) log(teachOn, "(no peer votes — jury still connecting / membership)");
      }
      await T.promote(id);
      log(teachOn, "✅ promoted → federating to the mesh");
      setG(teachOn, "yes");
      const others = urls.map((_, i) => i).filter((i) => i !== teachOn);
      await Promise.all(others.map(async (i) => {
        await K[i].sync().catch(() => {});
        for (let t = 0; t < 16; t++) {
          const c = await K[i].check(edit.a, edit.b);
          if (c?.grounded) { setG(i, "yes"); log(i, `✅ learned ${edit.a}+${edit.b} from peer (${c.severity})`); return; }
          await new Promise((r) => setTimeout(r, 700));
        }
        setG(i, "no"); log(i, "not yet — is this kiosk meshed / a member?");
      }));
    } finally { setBusy(false); }
  }

  async function enforceMembership() {
    setBusy(true); setMsg("collecting device keys…");
    try {
      const keys = (await Promise.all(K.map((k) => k.backend().then((b) => b?.devicePublicKey)))).filter(Boolean) as string[];
      await Promise.all(K.map((k) => k.members(keys)));
      setMsg(`🔒 membership ENFORCED — only these ${keys.length} kiosks may join + vote`);
    } finally { setBusy(false); }
  }
  async function openMesh() {
    setBusy(true);
    try { await Promise.all(K.map((k) => k.members([]))); setMsg("🔓 mesh OPEN — any kiosk with the code may join"); } finally { setBusy(false); }
  }

  const pill = (g: G) => g === "yes" ? "GREEN" : g === "no" ? "RED" : "AMBER";
  return (
    <>
      <div className="eyebrow">Demo <span className="badge">mesh · {urls.length} kiosks</span></div>
      <h1>A clinic network that learns — teach one, all learn</h1>
      <p className="lead">Teach a missed interaction on any kiosk; its jury of on-device AIs votes; you promote
        it — and every other kiosk's agent starts catching it (live, ~1 s). Only drug names cross the wire.
        Kiosks on the same code auto-mesh; optionally enforce membership so only allowlisted kiosks may join.</p>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", alignItems: "center" }}>
          <strong>Teach on:</strong>
          {urls.map((u, i) => <button key={i} className={`btn ghost${i === teachOn ? " active" : ""}`} onClick={() => setTeachOn(i)} disabled={busy}>Kiosk {String.fromCharCode(65 + i)}</button>)}
          <span style={{ flex: 1 }} />
          {SCENARIOS.map((s, i) => <button key={i} className={`btn ghost${i === sc ? " active" : ""}`} onClick={() => reset(i)} disabled={busy}>{s.a}+{s.b}</button>)}
        </div>
        <textarea value={edit.correction} onChange={(e) => setEdit({ ...edit, correction: e.target.value })} style={{ width: "100%", minHeight: 46, marginTop: 8 }} />
        <div className="row" style={{ marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={run} disabled={busy}>{busy ? "running…" : `▶ Teach on Kiosk ${String.fromCharCode(65 + teachOn)} → watch the mesh`}</button>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={enforceMembership} disabled={busy} title="Allowlist these kiosks' device keys — only they may join + vote">🔒 Enforce membership</button>
          <button className="btn ghost" onClick={openMesh} disabled={busy}>🔓 Open mesh</button>
        </div>
        {msg && <p className="note" style={{ marginTop: 6 }}>{msg}</p>}
      </div>

      <div className="row" style={{ gap: 12, alignItems: "stretch", flexWrap: "wrap" }}>
        {urls.map((u, i) => {
          const s = status[i];
          return (
            <div key={i} className="card" style={{ flex: "1 1 240px", borderTop: `3px solid ${i === teachOn ? "var(--green)" : "var(--amber)"}` }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ margin: 0 }}>Kiosk {String.fromCharCode(65 + i)} {i === teachOn && <span className="badge">teacher</span>}</h2>
                <span className={`pill ${pill(ground[i] || "?")}`}>{ground[i] === "yes" ? "flags it ✓" : ground[i] === "no" ? "no" : "—"}</span>
              </div>
              <p className="note">{s ? `${s.consultPeers ?? 0} peer(s) · ${s.membership?.enforced ? `member of ${s.membership.count}` : "open"}` : (s === null ? "offline?" : "…")}</p>
              <input value={u} onChange={(e) => setUrls(urls.map((x, j) => j === i ? e.target.value : x))} style={{ width: "100%", fontSize: 11 }} />
              <ol className="audit-timeline" style={{ marginTop: 6 }}>
                {(logs[i] || []).map((t, k) => <li key={k} className="audit-ev"><div className="audit-ev-sum">{t}</div></li>)}
                {!(logs[i] || []).length && <p className="note">—</p>}
              </ol>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ borderLeft: "3px solid var(--green)" }}>
        <strong>🔒 What crosses the mesh:</strong> <span className="pill GREEN">{edit.a}</span> + <span className="pill GREEN">{edit.b}</span>
        <span className="note"> + a de-identified note. <strong>Patient data: none.</strong> No central server. With membership on, only allowlisted, signature-verified kiosks may join or vote.</span>
      </div>
    </>
  );
}
