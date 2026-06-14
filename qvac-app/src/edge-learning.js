// Edge learning — the on-device, privacy-preserving knowledge loop. A clinician's correction
// (or an explicit "teach") becomes a CANDIDATE interaction edge that is adversarially vetted
// (by medpsy and/or peer kiosks over the consult channel) and, once it survives, PROMOTED
// into the shared interaction graph every kiosk grounds on — with PHI never leaving the
// device (an edge is two drug names + a generalized note + provenance, never the patient).
//
// Lifecycle mirrors the patient-fact one: proposed → (vetted) → promoted | rejected, on the
// SAME shared kb:medical graph (src/kb-sync.js replicates it). Candidate edges carry
// meta.proposed:true and are filtered OUT of grounding (see medlens.screenInteractions) until
// promoted — so the agent never grounds on un-vetted knowledge.
import { drugId } from "./medlens.js";

const KB = "kb:medical";
const drugName = (id) => String(id).replace(/^drug:/, "");
const learnedId = (a, b) => `lx:${a}>${b}`;            // learned edge (distinct from seeded ix:)
const reverseId = (id) => { const [a, b] = id.replace(/^lx:/, "").split(">"); return `lx:${b}>${a}`; };

// A clinician/agent proposes a candidate interaction edge (bidirectional). Lands proposed —
// replicates to peers but is NOT used for grounding until promoted.
export async function proposeEdge(kbStore, { a, b, severity = "moderate", note = "", contributedBy = null, evidence = null, log = KB }) {
  const [da, db] = [drugId(a), drugId(b)];
  if (!da || !db || da === db || da === "drug:" || db === "drug:") throw new Error("two distinct drug names required");
  const meta = { severity, note, proposed: true, learned: true, contributedBy, evidence, votes: [] };
  await kbStore.assert(log, { statementId: learnedId(da, db), subject: da, predicate: "interacts_with", object: { ref: db }, source: "learned", confidence: 0.5, meta });
  await kbStore.assert(log, { statementId: learnedId(db, da), subject: db, predicate: "interacts_with", object: { ref: da }, source: "learned", confidence: 0.5, meta });
  return { id: learnedId(da, db), a: da, b: db, severity };
}

// Adversarial vet: ask medpsy, as a SKEPTIC, whether a proposed interaction is clinically
// real. Defaulting to refute keeps weak/hallucinated edges out. Returns { real, severity, reason }.
export async function vetEdge(provider, { a, b, severity, note }) {
  const sys = "You are a skeptical clinical pharmacologist reviewing a PROPOSED drug-drug interaction before it enters a decision-support knowledge base. Be conservative: confirm only interactions that are real and clinically significant; refute vague, trivial, or fabricated ones.";
  const user = `Proposed: ${drugName(a)} + ${drugName(b)} — claimed severity "${severity}"${note ? `, note: "${note}"` : ""}.\nIs this a REAL, clinically significant interaction? Reply with ONLY a JSON object and nothing else:\n{"real": true|false, "severity": "major|moderate|minor", "reason": "<one sentence>"}`;
  let text = "";
  try { text = await provider.complete([{ role: "system", content: sys }, { role: "user", content: user }], { temperature: 0.2 }); }
  catch (e) { return { real: false, reason: `vet error: ${e?.message || e}` }; }
  const m = (text || "").replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!m) return { real: false, reason: "no parseable verdict" };
  try { const v = JSON.parse(m[0]); return { real: !!v.real, severity: v.severity || severity, reason: String(v.reason || "").slice(0, 200) }; }
  catch { return { real: false, reason: "unparseable verdict" }; }
}

// Record a vetting vote on a candidate edge (from medpsy or a peer). Votes accumulate in meta.
export async function recordVote(kbStore, edgeId, vote, { log = KB } = {}) {
  const facts = (await kbStore.fold(log, { predicate: "interacts_with" })).facts;
  const cur = facts.find((f) => f.statementId === edgeId)?.meta?.votes || [];
  const votes = [...cur, vote];
  await kbStore.correct(log, edgeId, { meta: { votes }, source: "network" }).catch(() => {});
  await kbStore.correct(log, reverseId(edgeId), { meta: { votes }, source: "network" }).catch(() => {});
  return votes;
}

// Promote a vetted candidate into the grounded graph (proposed:false, confidence 1) — both
// directions. After this the agent's screen_interactions grounds on it, and it gossips to peers.
export async function promoteEdge(kbStore, edgeId, { by = "network", severity, log = KB, now } = {}) {
  const stamp = { proposed: false, promotedBy: by, promotedAt: now || new Date().toISOString() };
  const meta = severity ? { ...stamp, severity } : stamp;
  await kbStore.correct(log, edgeId, { confidence: 1, source: "network", meta });
  await kbStore.correct(log, reverseId(edgeId), { confidence: 1, source: "network", meta }).catch(() => {});
  return { id: edgeId, promoted: true };
}

// Reject a candidate (retract it) — it never grounds and stops gossiping as active.
export async function rejectEdge(kbStore, edgeId, { reason = "rejected", log = KB } = {}) {
  await kbStore.retract(log, edgeId, { reason, source: "network" }).catch(() => {});
  await kbStore.retract(log, reverseId(edgeId), { reason, source: "network" }).catch(() => {});
  return { id: edgeId, rejected: true };
}

// Candidate edges awaiting promotion (deduped to one direction), newest-ish first.
export async function pendingEdges(kbStore, { log = KB } = {}) {
  const facts = (await kbStore.fold(log, { predicate: "interacts_with" })).facts;
  const seen = new Set(), out = [];
  for (const f of facts) {
    if (!f.meta?.proposed) continue;
    const key = [f.subject, f.object?.ref].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: f.statementId, a: f.subject, b: f.object?.ref, severity: f.meta?.severity, note: f.meta?.note,
      contributedBy: f.meta?.contributedBy, votes: f.meta?.votes || [] });
  }
  return out;
}
