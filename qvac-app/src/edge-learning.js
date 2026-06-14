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

// Best-effort de-identification of the ONE free-text field that leaves the device (a
// learned-edge note). Strips the patient identifiers that could appear if the model/clinician
// slips — emails, titled names, ages, dates, and long digit runs (MRN/phone) — while leaving
// clinical content intact (CYP2C9, J18.9, "5mg", "in patients with…" all survive, because
// their digit groups are short and they carry no title/age/date pattern). Defence in depth;
// the human review at promotion is the real backstop.
export const sanitizeNote = (s) => String(s || "")
  .replace(/\S+@\S+\.\S+/g, "[email]")                                                          // emails
  .replace(/\b(?:Mr|Mrs|Ms|Miss|Mx|Dr)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g, "[name]")        // titled names
  .replace(/\b\d{1,3}\s*(?:yo|y\/o|y\.o\.|years?[\s-]?old|yrs?[\s-]?old)\b/gi, "[age]")          // ages
  .replace(/\baged?\s+\d{1,3}\b/gi, "[age]")
  .replace(/\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b/g, "[date]")                                   // dates
  .replace(/\b\d{7,}\b/g, "[id]")                                                                // MRN / phone
  .replace(/\s+/g, " ").trim().slice(0, 200);

// Heuristic flag: does a note still look like it carries a patient reference after sanitizing?
// Surfaced to the clinician as a ⚠ before promotion (the note shouldn't mention "the patient").
export const noteLooksPersonal = (s) => /\b(?:the |this )patient\b|\bMRN\b|\bDOB\b|\[name\]|\[age\]|\[date\]|\[id\]/i.test(String(s || ""));
const learnedId = (a, b) => `lx:${a}>${b}`;            // learned edge (distinct from seeded ix:)
const reverseId = (id) => { const [a, b] = id.replace(/^lx:/, "").split(">"); return `lx:${b}>${a}`; };

// A clinician/agent proposes a candidate interaction edge (bidirectional). Lands proposed —
// replicates to peers but is NOT used for grounding until promoted.
export async function proposeEdge(kbStore, { a, b, severity = "moderate", note = "", contributedBy = null, evidence = null, log = KB }) {
  const [da, db] = [drugId(a), drugId(b)];
  if (!da || !db || da === db || da === "drug:" || db === "drug:") throw new Error("two distinct drug names required");
  // Don't duplicate an edge that already exists for this pair (seeded OR learned). If it's
  // already promoted it's known; if it's a pending candidate, return it (idempotent).
  const existing = (await kbStore.fold(log, { predicate: "interacts_with" })).facts
    .find((f) => (f.subject === da && f.object?.ref === db) || (f.subject === db && f.object?.ref === da));
  if (existing) {
    if (!existing.meta?.proposed) throw new Error(`${drugName(da)} + ${drugName(db)} is already a known interaction`);
    return { id: existing.statementId.startsWith("lx:") ? existing.statementId : learnedId(da, db), a: da, b: db, severity: existing.meta?.severity, existing: true };
  }
  const meta = { severity, note: sanitizeNote(note), proposed: true, learned: true, contributedBy, evidence, votes: [] };
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

// Record a vetting vote on a candidate edge (from medpsy or a peer). One vote per VOTER (a
// device pubkey, or "local") — re-vetting updates that voter's vote rather than inflating the
// tally. Votes accumulate in meta.
export async function recordVote(kbStore, edgeId, vote, { log = KB } = {}) {
  const facts = (await kbStore.fold(log, { predicate: "interacts_with" })).facts;
  const cur = facts.find((f) => f.statementId === edgeId)?.meta?.votes || [];
  const id = vote.voter || vote.by;
  const votes = [...cur.filter((v) => (v.voter || v.by) !== id), vote];
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

// AUTO-DISTILL: medpsy reads a clinician correction and/or an encounter (its meds + notes)
// and proposes NEW interaction edges — closing the loop with no human in the propose step
// (a human still gates promotion). Conservative: only real, clinically significant edges.
// Returns { edges:[{a,b,severity,note}] } — PHI-free (drug names + a generalized mechanism).
export async function distillEdges(provider, { meds = [], transcript = "", correction = "" }) {
  const sys = "You distill NEW drug-drug interactions worth adding to a triage decision-support knowledge base, from a community-pharmacy encounter. Be conservative: propose ONLY real, clinically significant interactions, and NEVER invent one. Output drug names and a GENERALIZED mechanism only — never any patient detail.";
  const parts = [];
  if (meds.length) parts.push(`Patient medications: ${meds.join(", ")}.`);
  if (correction) parts.push(`Clinician correction / note: ${correction}`);
  if (transcript) parts.push(`Encounter notes:\n${transcript.slice(0, 1500)}`);
  const user = `${parts.join("\n")}\n\nWhat drug-drug interactions should a triage assistant know from this? Reply with ONLY JSON:\n{"edges":[{"a":"drug","b":"drug","severity":"major|moderate|minor","note":"<brief mechanism>"}]}\nReturn {"edges":[]} if there are none.`;
  let text = "";
  try { text = await provider.complete([{ role: "system", content: sys }, { role: "user", content: user }], { temperature: 0.2 }); }
  catch (e) { return { edges: [], error: String(e?.message || e) }; }
  const m = (text || "").replace(/<think>[\s\S]*?<\/think>/g, "").match(/\{[\s\S]*\}/);
  if (!m) return { edges: [] };
  try {
    const o = JSON.parse(m[0]);
    const edges = (Array.isArray(o.edges) ? o.edges : []).filter((e) => e && e.a && e.b)
      .map((e) => ({ a: String(e.a), b: String(e.b), severity: ["major", "moderate", "minor"].includes(e.severity) ? e.severity : "moderate", note: sanitizeNote(e.note) }));
    return { edges };
  } catch { return { edges: [] }; }
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
      contributedBy: f.meta?.contributedBy, votes: f.meta?.votes || [], notePersonal: noteLooksPersonal(f.meta?.note) });
  }
  return out;
}
