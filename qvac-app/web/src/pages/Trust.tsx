// Trust dashboard — the "why you can trust this" surface for clinicians/judges: inference
// runs ON THIS DEVICE (no cloud), the agent's answers are GROUNDED in verified tools, and
// that grounding is MEASURED (the agent eval) and RECORDED (the tamper-evident audit).
// Clinician/operator-facing — English.
import { useEffect, useState } from "react";
import { getBackendInfo, getEvalResults, type BackendInfo, type EvalResults } from "../lib/trust";

function Bar({ pct }: { pct: number }) {
  const band = pct >= 90 ? "GREEN" : pct >= 70 ? "AMBER" : "RED";
  return (
    <div className="trust-bar-track" title={`${pct}%`}>
      <div className={`trust-bar-fill ${band}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function Trust() {
  const [be, setBe] = useState<BackendInfo | null>(null);
  const [evl, setEvl] = useState<EvalResults | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([getBackendInfo().then(setBe), getEvalResults().then(setEvl)]).finally(() => setLoaded(true));
  }, []);

  const s = evl?.summary;
  return (
    <>
      <div className="eyebrow">Trust</div>
      <h1>Trust &amp; provenance</h1>
      <p className="lead">Three things you can check before relying on a triage: it runs on this device,
        its answers are grounded in verified tools, and that grounding is measured and recorded.</p>

      {/* 1 — On-device */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>🔒 Runs on this device</h2>
        {be ? (
          <>
            <p>
              <span className={`pill ${be.onDevice ? "GREEN" : "AMBER"}`}>{be.onDevice ? "ON-DEVICE (QVAC)" : "DEV (LM Studio)"}</span>
              {" "}<span className="pill GREEN">NO CLOUD</span>
            </p>
            <p>Backend: <code>{be.backend}</code>
              {be.peerConsult && <> {" "}<span className="pill GREEN" title="The agent can reach a paired clinician device for a second opinion, peer-to-peer">👥 PEER CONSULT</span></>}
            </p>
            <p className="note">Model: <code>{be.model}</code></p>
            <p className="note">{be.note}</p>
          </>
        ) : <p className="note">{loaded ? "backend info unavailable (is the API server running?)" : "loading…"}</p>}
      </div>

      {/* 2 — Measured grounding (agent eval) */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>📊 Measured: the agent eval</h2>
        {s ? (
          <>
            <p className="note">
              backend <code>{evl!.backend}</code> · {evl!.runs} run(s)/case · {evl!.cases} cases · {new Date(evl!.at).toLocaleString()}
            </p>
            <div className="trust-metrics">
              {[
                { k: "Overall pass", v: s.overall },
                { k: "Tool-use correct", v: s.tool },
                { k: "Answer grounded", v: s.grounding },
              ].map((m) => (
                <div key={m.k} className="trust-metric">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span>{m.k}</span><strong>{m.v.pass}/{m.v.n} ({m.v.pct}%)</strong>
                  </div>
                  <Bar pct={m.v.pct} />
                </div>
              ))}
              {s.escalation.n > 0 && (
                <p className="note">Red-flag escalation: {s.escalation.pass}/{s.escalation.n} cases escalated.</p>
              )}
            </div>
            <details style={{ marginTop: 8 }}>
              <summary className="note">per-case ({evl!.rows.length})</summary>
              <ul className="kb-facts">
                {evl!.rows.map((r) => (
                  <li key={r.id} className="kb-fact">
                    <span className={`pill ${r.pass ? "GREEN" : "RED"}`}>{r.pass ? "PASS" : "FAIL"}</span>{" "}
                    <span className="mono">{r.id}</span>{" "}
                    <span className="note">tools: {r.tools.join(", ") || "—"}{r.expectTools.length ? ` (expected ${r.expectTools.join(", ")})` : ""}</span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        ) : (
          <p className="note">{loaded ? "No eval results yet — run " : ""}<code>{loaded ? "npm run agent-eval" : "loading…"}</code>{loaded ? " (or MEDPSY_BACKEND=qvac node scripts/agent_eval.mjs) to populate this." : ""}</p>
        )}
      </div>

      {/* 3 — Recorded (audit) */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>🛡 Recorded: every decision is grounded &amp; auditable</h2>
        <p>Each tool the agent calls is logged as a <strong>grounding receipt</strong> (which verified facts /
          codes / interactions it used) into the per-encounter, hash-chained <a href="/audit">audit log</a> —
          so any decision can be traced to the immutable facts behind it, and tampering is detectable.</p>
        <p className="note">Verified ICD-10 codes come from a lookup tool (never the model's guess); drug interactions
          from an authored graph; patient facts only when confirmed by a clinician.</p>
      </div>
    </>
  );
}
