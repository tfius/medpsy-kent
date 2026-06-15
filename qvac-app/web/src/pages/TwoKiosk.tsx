// Two-kiosk federated-learning demo — the base idea, made visible. You act on Kiosk A
// (teach → jury vet → promote) and watch Kiosk B's agent flip from "does NOT flag" to "flags
// it", with only two drug names crossing between the devices. Talks to both kiosks by absolute
// URL (cross-origin; servers send CORS). Run `npm run demo:two-kiosk` to start A + B paired.
import { useEffect, useState } from "react";
import { kiosk } from "../lib/kiosk";
import { drug } from "../lib/learn";

const SCENARIOS = [
  { a: "amiodarone", b: "simvastatin", correction: "Overrode triage — amiodarone + simvastatin: amiodarone inhibits CYP3A4, raising simvastatin to myopathy/rhabdomyolysis risk. MAJOR, the assistant missed it." },
  { a: "warfarin", b: "miconazole", correction: "Overrode triage — warfarin + oral miconazole gel: CYP2C9/3A4 inhibition, raised INR/bleeding. MAJOR, missed." },
  { a: "clarithromycin", b: "ergotamine", correction: "Missed: clarithromycin (CYP3A4 inhibitor) + ergotamine → ergotism / vasospasm. Major — should be flagged." },
];
type Entry = { t: string; tone: "ok" | "warn" | "info" };

export default function TwoKiosk() {
  const [aUrl, setAUrl] = useState("http://localhost:8787");
  const [bUrl, setBUrl] = useState("http://localhost:8788");
  const [sc, setSc] = useState(0);
  const [edit, setEdit] = useState(SCENARIOS[0]);
  const [aLog, setALog] = useState<Entry[]>([]);
  const [bLog, setBLog] = useState<Entry[]>([]);
  const [bFlags, setBFlags] = useState<"?" | "no" | "yes">("?");
  const [busy, setBusy] = useState(false);
  const [jurors, setJurors] = useState<number | null>(null); // peer kiosks A can poll for votes

  const A = kiosk(aUrl), B = kiosk(bUrl);

  // Live readiness: how many peer kiosks is A connected to (the jury)?
  useEffect(() => {
    let on = true;
    const tick = () => A.backend().then((bi) => { if (on) setJurors((bi as { consultPeers?: number })?.consultPeers ?? null); });
    tick(); const t = setInterval(tick, 4000);
    return () => { on = false; clearInterval(t); };
  }, [aUrl]);
  const a = (t: string, tone: Entry["tone"] = "info") => setALog((l) => [...l, { t, tone }]);
  const b = (t: string, tone: Entry["tone"] = "info") => setBLog((l) => [...l, { t, tone }]);
  function reset(i = sc) { setSc(i); setEdit(SCENARIOS[i]); setALog([]); setBLog([]); setBFlags("?"); }

  async function pair() {
    setBusy(true);
    try {
      const s = await A.share();
      if (!s?.key) { a("could not reach Kiosk A — is it running on " + aUrl + "?", "warn"); return; }
      a(`sharing graph (key ${s.key.slice(0, 12)}…)`, "ok");
      const j = await B.join(s.key);
      b(j?.joined ? `joined Kiosk A's graph — replicating, no server` : `join: ${j?.reason || "failed (is B running?)"}`, j?.joined ? "ok" : "warn");
    } finally { setBusy(false); }
  }

  async function run() {
    setBusy(true); setALog([]); setBLog([]);
    try {
      // 0 — B before
      const before = await B.check(edit.a, edit.b);
      if (!before) { b("could not reach Kiosk B — is it running on " + bUrl + "?", "warn"); return; }
      setBFlags(before.grounded ? "yes" : "no");
      b(before.grounded ? `already flags ${edit.a} + ${edit.b} (pick another pair)` : `agent does NOT flag ${edit.a} + ${edit.b}`, before.grounded ? "info" : "warn");
      if (before.grounded) return;

      // 1 — teach on A (distil)
      const d = await A.distill(edit.correction);
      const id = d?.proposed?.[0]?.id || (await A.learn())?.pending.slice(-1)[0]?.id || null;
      a(d?.proposed?.length ? `medpsy distilled a candidate: ${d.proposed.map((p) => `${drug(p.a)} + ${drug(p.b)}`).join(", ")}` : "nothing new (already known?)", d?.proposed?.length ? "ok" : "info");
      if (!id) return;

      // 2 — jury vet on A (its medpsy + peer kiosks incl. B)
      const v = await A.vet(id);
      if (v?.local) {
        a(`jury — this kiosk: ${v.local.real ? "REAL" : "REFUTED"} (${v.local.severity ?? "?"})`, v.local.real ? "ok" : "warn");
        for (const p of v.peers || []) a(`jury — peer ${p.by} ${p.signatureOk ? "✓" : "✗"}: ${p.real ? "REAL" : "REFUTED"} (${p.severity ?? "?"})`, p.real ? "ok" : "warn");
        if (!v.peers?.length) a("(no peer kiosks voted — local only; give consult a few seconds to connect)", "info");
      }

      // 3 — promote on A
      await A.promote(id);
      a(`promoted into the shared graph — replicating to peers now (no server)`, "ok");

      // 4 — watch B learn it LIVE. The promotion replicates to B in ~1 s and B merges on the
      // core's append event — so we just poll B until its agent grounds (a sync() kick + poll
      // belt-and-suspenders for the backstop interval).
      b(`replicating from A… (live, no server)`, "info");
      await B.sync();
      let grounded = false, sev: string | null = null;
      for (let i = 0; i < 16 && !grounded; i++) {
        const c = await B.check(edit.a, edit.b);
        grounded = !!c?.grounded; sev = c?.severity || null;
        if (!grounded) await new Promise((r) => setTimeout(r, 700));
      }
      setBFlags(grounded ? "yes" : "no");
      b(grounded ? `✓ agent NOW flags ${edit.a} + ${edit.b} (${sev}) — learned from Kiosk A, no patient data crossed` : "not grounded yet — give it a moment, then Pair/Sync", grounded ? "ok" : "warn");
    } finally { setBusy(false); }
  }

  const Col = ({ title, sub, log, accent }: { title: string; sub: string; log: Entry[]; accent: string }) => (
    <div className="card" style={{ flex: 1, borderTop: `3px solid ${accent}` }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p className="note">{sub}</p>
      <ol className="audit-timeline">
        {log.map((e, i) => <li key={i} className="audit-ev"><div className="audit-ev-sum" style={{ color: e.tone === "ok" ? "var(--green)" : e.tone === "warn" ? "var(--amber)" : undefined }}>{e.tone === "ok" ? "✅ " : e.tone === "warn" ? "⚠️ " : "• "}{e.t}</div></li>)}
        {log.length === 0 && <p className="note">—</p>}
      </ol>
    </div>
  );

  return (
    <>
      <div className="eyebrow">Demo <span className="badge">federated learning · 2 kiosks</span></div>
      <h1>Watch one kiosk teach another — no PHI, no server</h1>
      <p className="lead">Teach a missed interaction on <strong>Kiosk A</strong>; its jury of on-device AIs votes; you
        promote it — and <strong>Kiosk B</strong>'s agent starts catching it (live, ~1 s). Only two drug names ever
        cross between the devices. Kiosks on the same code <strong>auto-mesh</strong> — bidirectional, N kiosks, no
        pairing — so teaching on B would teach A too.</p>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", alignItems: "center" }}>
          <label>A <input value={aUrl} onChange={(e) => setAUrl(e.target.value)} style={{ width: 170 }} /></label>
          <label>B <input value={bUrl} onChange={(e) => setBUrl(e.target.value)} style={{ width: 170 }} /></label>
          <button className="btn ghost" onClick={pair} disabled={busy} title="Optional — kiosks on the same code auto-mesh; this just kicks it instantly">🔗 Pair now</button>
          <span className={`pill ${jurors ? "GREEN" : "AMBER"}`} title="peer kiosks connected to A's consult jury">
            {jurors === null ? "jury: ?" : jurors > 0 ? `jury: ${jurors} peer${jurors > 1 ? "s" : ""} ✓` : "jury: connecting…"}
          </span>
          <span style={{ flex: 1 }} />
          {SCENARIOS.map((s, i) => <button key={i} className={`btn ghost${i === sc ? " active" : ""}`} onClick={() => reset(i)} disabled={busy}>{s.a}+{s.b}</button>)}
        </div>
        <textarea value={edit.correction} onChange={(e) => setEdit({ ...edit, correction: e.target.value })} style={{ width: "100%", minHeight: 48, marginTop: 8 }} />
        <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
          <button className="btn" onClick={run} disabled={busy}>{busy ? "running…" : "▶ Teach on A → watch B learn"}</button>
          <span style={{ flex: 1 }} />
          <strong>Kiosk B flags {edit.a} + {edit.b}?</strong>
          <span className={`pill ${bFlags === "yes" ? "GREEN" : bFlags === "no" ? "RED" : "AMBER"}`} style={{ fontSize: 16 }}>{bFlags === "yes" ? "YES ✓" : bFlags === "no" ? "NO" : "—"}</span>
        </div>
      </div>

      <div className="row" style={{ gap: 12, alignItems: "stretch" }}>
        <Col title="🏥 Kiosk A — teacher" sub="learns the correction, runs the jury, promotes" log={aLog} accent="var(--green)" />
        <Col title="🏥 Kiosk B — learner" sub="replicates A's graph; its agent grounds on what A taught" log={bLog} accent="var(--amber)" />
      </div>

      <div className="card" style={{ borderLeft: "3px solid var(--green)" }}>
        <strong>🔒 What crossed between the kiosks:</strong> <span className="pill GREEN">{edit.a}</span> <span className="note">+</span> <span className="pill GREEN">{edit.b}</span>
        <span className="note"> · the edge + a de-identified note. <strong>Patient data: none.</strong> No central server.</span>
      </div>
    </>
  );
}
