// Guided demo — walks the whole edge-learning loop on one screen so the story lands in ~60s:
// a clinician's correction → medpsy distils the edge → a jury of on-device AIs vote → a human
// promotes → and the agent on every kiosk now catches it. The before/after "would the agent
// flag this?" check is the punchline. Clinician/judge-facing — English.
import { useRef, useState } from "react";
import { distill, vetEdge, promoteEdge, getLearning, checkPair, drug, type VetResult } from "../lib/learn";

const SCENARIOS = [
  { a: "warfarin", b: "miconazole", correction: "Overrode the triage — patient on warfarin was prescribed oral miconazole gel. Miconazole inhibits CYP2C9/CYP3A4, markedly raising INR and bleeding risk. MAJOR interaction the assistant missed." },
  { a: "phenytoin", b: "fluconazole", correction: "Overrode the triage — phenytoin + fluconazole: fluconazole inhibits CYP2C9, raising phenytoin levels toward toxicity. The assistant didn't flag it." },
  { a: "carbamazepine", b: "clarithromycin", correction: "Missed interaction: clarithromycin inhibits CYP3A4 and raises carbamazepine to toxic levels — should be flagged as major." },
];

type Entry = { label: string; detail: string; tone: "ok" | "warn" | "info" };

export default function Demo() {
  const [sc, setSc] = useState(0);
  const [edit, setEdit] = useState(SCENARIOS[0]);
  const [log, setLog] = useState<Entry[]>([]);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState<{ a: string; b: string; note: string } | null>(null);
  const edgeRef = useRef<string | null>(null); // carried across steps (refs avoid stale closures in auto-run)

  const push = (e: Entry) => setLog((l) => [...l, e]);
  function reset(i = sc) { setSc(i); setEdit(SCENARIOS[i]); setLog([]); setStep(0); setShared(null); edgeRef.current = null; }

  const STEPS: { title: string; run: () => Promise<void> }[] = [
    {
      title: "1 · Ask the agent (before)",
      run: async () => {
        const r = await checkPair(edit.a, edit.b);
        push(r?.grounded
          ? { label: "Agent check — before", detail: `Already flags ${edit.a} + ${edit.b}. Pick another pair to see learning.`, tone: "info" }
          : { label: "Agent check — before", detail: `The agent does NOT flag ${edit.a} + ${edit.b} — it isn't in the knowledge base yet.`, tone: "warn" });
      },
    },
    {
      title: "2 · Clinician correction → medpsy distils the edge",
      run: async () => {
        const r = await distill(edit.correction);
        let id = r?.proposed?.[0]?.id || null;
        const L = await getLearning();
        if (!id) id = L?.pending.find((c) => `${c.a}${c.b}`.includes(edit.b.toLowerCase()))?.id || L?.pending.slice(-1)[0]?.id || null;
        edgeRef.current = id;
        const cand = L?.pending.find((c) => c.id === id);
        if (cand) setShared({ a: drug(cand.a), b: drug(cand.b), note: cand.note || "" }); // exactly what will leave the device
        push({ label: "Auto-distill", detail: r?.proposed?.length ? `medpsy read the correction and proposed: ${r.proposed.map((p) => `${drug(p.a)} + ${drug(p.b)}`).join(", ")} — a CANDIDATE (not yet trusted).` : "Nothing new proposed (already known?).", tone: r?.proposed?.length ? "ok" : "info" });
      },
    },
    {
      title: "3 · A jury of on-device AIs vote",
      run: async () => {
        const id = edgeRef.current;
        if (!id) { push({ label: "Vet", detail: "no candidate to vet", tone: "warn" }); return; }
        const v: VetResult | null = await vetEdge(id);
        if (!v?.local) { push({ label: "Vet", detail: `vet failed${(v as { error?: string })?.error ? `: ${(v as { error?: string }).error}` : ""}`, tone: "warn" }); return; }
        const lines = [`this kiosk: ${v.local.real ? "REAL" : "REFUTED"} (${v.local.severity ?? "?"}) — ${v.local.reason ?? ""}`,
          ...(v.peers || []).map((p) => `peer ${p.by} ${p.signatureOk ? "✓" : "✗"}: ${p.real ? "REAL" : "REFUTED"} (${p.severity ?? "?"})`)];
        push({ label: "Adversarial vet", detail: lines.join("  •  ") + (v.peers?.length ? "" : "  •  (no peer kiosks connected — local only)"), tone: v.local.real ? "ok" : "warn" });
      },
    },
    {
      title: "4 · Clinician promotes it",
      run: async () => {
        const id = edgeRef.current;
        if (!id) { push({ label: "Promote", detail: "no candidate", tone: "warn" }); return; }
        await promoteEdge(id);
        push({ label: "Promote", detail: `Promoted into the shared, federated graph — it now replicates to every kiosk (no server).`, tone: "ok" });
      },
    },
    {
      title: "5 · Ask the agent (after)",
      run: async () => {
        const r = await checkPair(edit.a, edit.b);
        push(r?.grounded
          ? { label: "Agent check — after", detail: `✓ The agent now flags ${edit.a} + ${edit.b} as a ${r.severity ?? ""} interaction — and so will every kiosk it federates to.`, tone: "ok" }
          : { label: "Agent check — after", detail: `not grounded yet (try the vet/promote steps)`, tone: "warn" });
      },
    },
  ];

  async function runStep(i: number) { await STEPS[i].run(); setStep(i + 1); }
  async function next() {
    if (busy || step >= STEPS.length) return;
    setBusy(true);
    try { await runStep(step); } finally { setBusy(false); }
  }
  async function runAll() {
    if (busy) return;
    setBusy(true);
    try { for (let i = step; i < STEPS.length; i++) { await runStep(i); await new Promise((r) => setTimeout(r, 900)); } }
    finally { setBusy(false); }
  }

  const done = step >= STEPS.length;
  return (
    <>
      <div className="eyebrow">Demo <span className="badge">edge-learning loop</span></div>
      <h1>A clinic that learns — with no PHI leaving</h1>
      <p className="lead">Watch one correction become network-wide knowledge: medpsy distils it, a jury of
        on-device AIs vote, a clinician approves, and every kiosk's agent starts catching it. The only thing
        that ever crosses the wire is two drug names.</p>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", alignItems: "center" }}>
          <strong>Scenario:</strong>
          {SCENARIOS.map((s, i) => (
            <button key={i} className={`btn ghost${i === sc ? " active" : ""}`} onClick={() => reset(i)} disabled={busy}>{s.a} + {s.b}</button>
          ))}
        </div>
        <textarea value={edit.correction} onChange={(e) => setEdit({ ...edit, correction: e.target.value })} style={{ width: "100%", minHeight: 56, marginTop: 8 }} disabled={step > 1} />
        <div className="trust-bar-track" style={{ marginTop: 10 }}><div className="trust-bar-fill GREEN" style={{ width: `${(step / STEPS.length) * 100}%` }} /></div>
        <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
          {!done
            ? <>
                <button className="btn" onClick={next} disabled={busy}>{busy ? "running…" : `▶ Step ${step + 1}/${STEPS.length}: ${STEPS[step].title.replace(/^\d+ · /, "")}`}</button>
                <button className="btn ghost" onClick={runAll} disabled={busy}>▶▶ Auto-run</button>
              </>
            : <><span className="pill GREEN">✓ loop complete</span> <a className="btn ghost" href="/audit">🛡 see the provenance (kb-learning)</a></>}
          <button className="btn ghost" onClick={() => reset()} disabled={busy}>↻ Restart</button>
        </div>
      </div>

      {shared && (
        <div className="card" style={{ borderLeft: "3px solid var(--green)" }}>
          <strong>🔒 What left this device</strong>
          <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
            <span className="pill GREEN">{shared.a}</span><span className="note">+</span><span className="pill GREEN">{shared.b}</span>
            {shared.note && <span className="note">· “{shared.note}”</span>}
          </div>
          <p className="note" style={{ marginTop: 6 }}>Patient data shared: <strong>none</strong>. Two drug names + a generalized,
            de-identified note replicate to peers — never the patient, the encounter, or any record.</p>
        </div>
      )}

      <ol className="audit-timeline">
        {log.map((e, i) => (
          <li key={i} className="audit-ev">
            <div className="audit-ev-head">
              <span className="audit-ev-type">{e.tone === "ok" ? "✅" : e.tone === "warn" ? "⚠️" : "•"} {e.label}</span>
            </div>
            <div className="audit-ev-sum">{e.detail}</div>
          </li>
        ))}
        {log.length === 0 && <p className="note">Press “Run step 1” to begin.</p>}
      </ol>
    </>
  );
}
