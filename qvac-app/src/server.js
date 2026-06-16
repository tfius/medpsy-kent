// Tiny ICD-10 grounding API for the web UI. Reuses our verified lookup (icd-index.js)
// + provider embeddings. No external deps on the LM Studio path (built-in http/fetch).
//   node src/server.js          # serves POST /api/icd {condition} -> verified code(s)
//   node src/server.js --profile clinic-b --port 8788 --consult-code CLINIC   # one flag, not 8 env vars
import bootCfg from "./bootstrap-config.js"; // MUST be first — turns CLI flags / config file / --profile into env
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProvider } from "./backend.js";
import { loadOrBuildIndex, verifyIcd } from "./icd-index.js";
import { searchKnowledge } from "./knowledge.js";
import * as audit from "./audit.js";
import * as identity from "./identity.js";
import { createFactStore, NodeFileAdapter, makeFactstoreTools } from "@qvac/factstore";
import { HypercoreAdapter } from "@qvac/factstore/hypercore";
import { exportOKF, importOKF } from "@qvac/factstore/okf";
import { shareLog, joinLog } from "./kb-sync.js";
import { makeConsultTool, createConsultClient } from "./consult.js";
import { verifyRoster } from "./roster.js";
import { memberOf, isCountableVote } from "./membership.js";
import { proposeEdge, vetEdge, recordVote, promoteEdge, rejectEdge, pendingEdges, distillEdges } from "./edge-learning.js";
import { observeCooccurrence, aggregateSignals, detectSignals, autoProposeSignals, DEFAULT_THRESHOLD, pairKey } from "./signals.js";
import { seedInteractions, makeInteractionTool, drugId } from "./medlens.js";
import { encounterToOKF } from "./audit-okf.js";
import { stripThink } from "./think.js";
import { BACKEND, QVAC_LLM_GGUF, LMSTUDIO_LLM, LMSTUDIO_URL } from "./config.js";

// OKF (Open Knowledge Format) interchange directory — exported knowledge bundles are
// written here as real .md directories the OKF visualizer/catalog can open. Knowledge
// layer only; PHI audit logs are NEVER written here (they stay signed/hash-chained).
const OKF_DIR = process.env.MEDPSY_OKF_DIR || path.join(import.meta.dirname, "..", "okf");
const okfSlug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "log";
// Write an OKF bundle ({ "<path>.md": content }) to disk under baseDir, creating nested
// concept subdirs. Returns the absolute base directory written to.
function writeOKFDir(baseDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(baseDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return baseDir;
}

// On-device speech is optional (needs @qvac/sdk + models). Loaded lazily on first use.
let speech = null;
async function getSpeech() {
  if (!speech) speech = await import("./speech.js");
  return speech;
}
// P2P handoff (hyperswarm) is loaded lazily too — only when a transfer is requested.
let p2p = null;
async function getP2p() {
  if (!p2p) p2p = await import("./p2p.js");
  return p2p;
}
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks)));
});

const PORT = Number(process.env.API_PORT) || 8787;

const provider = await getProvider();
await provider.init();
console.log(`[icd-api] backend ${provider.name}; loading index…`);
const index = await loadOrBuildIndex(provider, (d, t) => {
  if (d % 2560 === 0 || d === t) process.stdout.write(`\r  embedding ICD ${d}/${t}`);
});
console.log(`\n[icd-api] ready on http://localhost:${PORT}`);

// Bi-temporal fact store (@qvac/factstore) — on-device patient/agent memory. PHI lives
// under MEDPSY_FACTS_DIR (gitignored, like ./audit). Bundles are ed25519-signed with the
// same device identity used for audit handoff. Purely additive: nothing else depends on it.
const facts = createFactStore({
  adapter: new NodeFileAdapter({ dir: process.env.MEDPSY_FACTS_DIR || path.join(import.meta.dirname, "..", "facts") }),
  signer: { sign: identity.sign, identity: identity.getIdentity },
  verify: identity.verify,
});
// Seed the authored drug-interaction graph into kb:medical (idempotent).
seedInteractions(facts).catch((e) => console.warn(`[facts] interaction seed skipped: ${e?.message || e}`));

// Shared KNOWLEDGE graph on a hypercore — the interaction graph the agent grounds on, kept
// SEPARATE from the PHI `facts` store so it can be replicated kiosk-to-kiosk over hyperswarm
// (src/kb-sync.js) with no server. Reader kiosks fold in peers' edges; PHI never leaves.
const kbAdapter = new HypercoreAdapter({ storage: process.env.MEDPSY_KB_DIR || path.join(import.meta.dirname, "..", "kb-cores") });
const kbStore = createFactStore({ adapter: kbAdapter });
seedInteractions(kbStore).catch((e) => console.warn(`[kb] interaction seed skipped: ${e?.message || e}`));
let kbShare = null;        // { keyHex, swarm } once this device is sharing its graph
let myKbKey = null;        // this kiosk's kb:medical core key (announced to the mesh)
const kbPeers = [];        // [{ key, log, swarm, importedAt }] joined peer graphs
// Pull a joined peer's edges into the local kb:medical. Only NEW or CHANGED edges are
// asserted — assert() always appends to the chain (statementId dedupes at fold, not append),
// so blindly re-asserting on every re-sync would grow the core unbounded for a static graph.
// Returns how many edges were actually merged this pass.
async function mergePeerGraph(peerLog) {
  const [peerEdges, localEdges] = await Promise.all([
    kbStore.fold(peerLog, { predicate: "interacts_with" }).then((r) => r.facts),
    kbStore.fold("kb:medical", { predicate: "interacts_with" }).then((r) => r.facts),
  ]);
  // Compare object AND trust state — so a peer PROMOTING a candidate (a meta change, same
  // object) propagates, while a truly-unchanged edge is skipped (no unbounded append).
  const sig = (f) => JSON.stringify([f.object, f.meta?.proposed, f.meta?.severity, f.confidence]);
  const localById = new Map(localEdges.map((f) => [f.statementId, sig(f)]));
  let merged = 0;
  for (const f of peerEdges) {
    if (localById.get(f.statementId) === sig(f)) continue; // already present, unchanged
    await kbStore.assert("kb:medical", { statementId: f.statementId, subject: f.subject, predicate: "interacts_with", object: f.object, source: f.source || "peer", confidence: f.confidence, meta: f.meta }).catch(() => {});
    merged++;
  }
  return merged;
}

// Replicate + merge a peer's KB graph (idempotent: dedup by key). Used by the manual
// /api/kb/join endpoint AND the auto-discovered mesh (a peer's announced KB key). LIVE: merges
// the instant the peer's core appends; a slow interval is a catch-up backstop. Returns
// { joined, imported } or { joined:false } if it was a self/duplicate/invalid key.
const kbJoining = new Set(); // keys currently being joined (avoid a race on concurrent announces)
async function joinPeer(key) {
  if (!key || !/^[0-9a-f]{64}$/i.test(key) || key === myKbKey) return { joined: false, reason: "self/invalid" };
  if (kbPeers.some((p) => p.key === key) || kbJoining.has(key)) return { joined: false, reason: "already joined" };
  kbJoining.add(key);
  try {
    const peerLog = `kb:peer:${key.slice(0, 12)}`;
    const { swarm, core } = await joinLog(kbAdapter, peerLog, key);
    const imported = await mergePeerGraph(peerLog);
    let merging = false;
    const syncNow = () => { if (merging) return; merging = true; mergePeerGraph(peerLog).catch(() => {}).finally(() => { merging = false; }); };
    core.on("append", syncNow);
    const peer = { key, log: peerLog, swarm, importedAt: new Date().toISOString(), _timer: setInterval(syncNow, Number(process.env.MEDPSY_KB_SYNC_MS) || 30000) };
    kbPeers.push(peer);
    return { joined: peerLog, imported };
  } finally { kbJoining.delete(key); }
}

// P2P "consult a colleague" — when a consult code is configured, the agent gets a tool to
// reach a paired senior-clinician device for a second opinion (src/consult.js). No cloud.
const CONSULT_CODE = process.env.MEDPSY_CONSULT_CODE || null;
// One persistent consult swarm per kiosk: it ASKS peers (the jury / second opinion) AND
// ANSWERS them (so every kiosk is a juror — it vets peers' edges with its own medpsy). The
// client ignores its own pubkey, so a kiosk never votes on its own edge.
const CONSULT_SYS = "You are a SENIOR clinician giving a brief second opinion to a community pharmacist's triage assistant. 2-4 sentences: red flags, safest disposition, anything to add. Advisory.";
// OPT-IN membership: an allowlist of authorized peer DEVICE pubkeys. null = OPEN mesh (anyone
// with the code joins — fine for a demo). When set, only allowlisted devices (verified by their
// signed announce) may auto-join the mesh, and only their votes count in the jury — so a
// member's (re-)vet-free promoted edges only federate from TRUSTED kiosks. Settable at startup
// (MEDPSY_CONSULT_MEMBERS=hexpub,hexpub) or at runtime (POST /api/consult/members).
const myPub = identity.getIdentity().publicKey;
let meshMembers = process.env.MEDPSY_CONSULT_MEMBERS
  ? new Set(process.env.MEDPSY_CONSULT_MEMBERS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
  : null;
const isMember = (pub) => memberOf(meshMembers, myPub, pub); // reads meshMembers live (src/membership.js)

// A SIGNED roster (from a trusted issuer/admin) is the tamper-evident way to set the allowlist:
// accept it only if it verifies against the one issuer key we trust. Source: config `roster` +
// `rosterIssuer`, or a --roster file. Applying a verified roster overrides the plain members list.
const ROSTER_ISSUER = process.env.MEDPSY_ROSTER_ISSUER || null;
function applyRoster(roster, { runtime = false } = {}) {
  if (!roster) return { ok: false, reason: "no roster" };
  if (!ROSTER_ISSUER) return { ok: false, reason: "no trusted rosterIssuer configured" };
  const members = verifyRoster(roster, ROSTER_ISSUER);
  if (!members) { console.warn(`[kb-mesh] roster REJECTED (untrusted issuer or bad signature)`); return { ok: false, reason: "untrusted issuer or bad signature" }; }
  meshMembers = new Set(members);
  console.log(`[kb-mesh] signed roster accepted${runtime ? " (runtime)" : ""} — ${members.length} member(s), issuer ${roster.issuer.slice(0, 12)}…`);
  return { ok: true, count: members.length };
}
if (ROSTER_ISSUER) {
  // A trusted issuer is configured ⇒ membership is INTENDED. Fail CLOSED: admit no peers until a
  // VALID signed roster is accepted (so a missing/forged roster can't force the mesh open).
  let roster = bootCfg?.roster || null;
  if (!roster && process.env.MEDPSY_ROSTER_FILE) { try { roster = JSON.parse(fs.readFileSync(process.env.MEDPSY_ROSTER_FILE, "utf8")); } catch (e) { console.warn(`[kb-mesh] roster file unreadable: ${e?.message || e}`); } }
  if (!applyRoster(roster).ok) { meshMembers = new Set(); console.warn(`[kb-mesh] membership CLOSED — only self until a roster signed by ${ROSTER_ISSUER.slice(0, 12)}… is accepted`); }
}
let consultClient = null;
if (CONSULT_CODE) {
  // MESH: share this kiosk's KB core, then announce its (signed) key to every peer on the
  // consult swarm and auto-join authorized peers as they announce theirs — bidirectional
  // federation, no manual pairing. The same swarm is the jury. (Manual /api/kb/join still works.)
  try { kbShare = await shareLog(kbAdapter, "kb:medical"); myKbKey = kbShare.keyHex; } catch (e) { console.warn(`[kb-mesh] share skipped: ${e?.message || e}`); }
  consultClient = createConsultClient(CONSULT_CODE, {
    answerFn: async (q, ctx) => (await provider.complete([{ role: "system", content: CONSULT_SYS }, { role: "user", content: ctx ? `${q}\n\nContext: ${ctx}` : q }], { temperature: 0.3 })).trim(),
    vetFn: async (edge) => (await import("./edge-learning.js")).vetEdge(provider, edge),
    announce: myKbKey,
    isMember: (pub) => isMember(pub), // serve our KB key only to verified members
    onAnnounce: (key, from, fromOk) => {
      if (!fromOk) return; // unsigned/forged announce — ignore
      if (!isMember(from?.publicKey)) { console.log(`[kb-mesh] rejected non-member ${String(from?.publicKey).slice(0, 12)}…`); return; }
      joinPeer(key).then((r) => { if (r.joined) console.log(`[kb-mesh] auto-joined peer ${key.slice(0, 12)}…`); }).catch(() => {});
    },
  });
  console.log(`[consult] mesh enabled (code "${CONSULT_CODE}") — jury + auto-federated KB; membership: ${meshMembers ? meshMembers.size + " allowlisted" : "OPEN"}`);
}
const consultTools = consultClient ? [makeConsultTool(consultClient)] : [];

// Agentic-triage conversations, kept per encounter (in-memory; a kiosk session is short).
const triageSessions = new Map(); // encounterId -> { messages: [] }
const triageInFlight = new Set(); // encounterIds with a turn in progress (one turn at a time per encounter)

// Warm the on-device STT model now so the first dictation isn't "stuck" loading.
// Skippable so the two-kiosk demo (two server processes) doesn't spin up 4 speech workers.
if (process.env.MEDPSY_NO_SPEECH !== "1") getSpeech().then((sp) => { sp.prewarmStt?.(); sp.prewarmTts?.(); }).catch(() => {});

const cors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
};

http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Backend provenance for the Trust dashboard — is inference on-device (QVAC) or via the
  // dev LM Studio server, and where the model lives. Neither path is cloud.
  if (req.method === "GET" && req.url === "/api/backend") {
    const onDevice = BACKEND === "qvac";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      backend: provider.name, mode: BACKEND, onDevice, cloud: false,
      peerConsult: !!CONSULT_CODE, // agent can reach a paired clinician device (P2P)
      consultPeers: consultClient?.peerCount?.() ?? null, // connected consult peers (jurors)
      devicePublicKey: myPub,
      membership: { enforced: !!meshMembers, count: meshMembers ? meshMembers.size : null }, // mesh allowlist
      model: onDevice ? QVAC_LLM_GGUF : `${LMSTUDIO_LLM} @ ${LMSTUDIO_URL}`,
      note: onDevice
        ? "All inference runs on this device via @qvac/sdk (local .gguf) — no cloud, no outbound model calls."
        : "Dev backend: LM Studio's local server on this machine (not cloud, but not the on-device QVAC path).",
    }));
    return;
  }
  // Mesh membership (opt-in). GET → status; POST {keys:[hexpub,…]} → enforce an allowlist at
  // runtime (empty/[] → reopen the mesh). Only allowlisted devices auto-join + vote.
  if (req.url.split("?")[0] === "/api/consult/members") {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST") {
      try {
        const { keys } = JSON.parse((await readBody(req)).toString() || "{}");
        meshMembers = Array.isArray(keys) && keys.length
          ? new Set(keys.map((k) => String(k).trim().toLowerCase()).filter((k) => /^[0-9a-f]{64}$/.test(k)))
          : null;
        console.log(`[kb-mesh] membership ${meshMembers ? "ENFORCED (" + meshMembers.size + ")" : "OPEN"}`);
      } catch { /* ignore bad body */ }
    }
    res.end(JSON.stringify({ enforced: !!meshMembers, count: meshMembers ? meshMembers.size : null, self: myPub, rosterIssuer: ROSTER_ISSUER }));
    return;
  }
  // Push a SIGNED roster at runtime — applied only if it verifies against the trusted issuer.
  if (req.method === "POST" && req.url.split("?")[0] === "/api/consult/roster") {
    res.writeHead(200, { "content-type": "application/json" });
    let roster = null; try { roster = JSON.parse((await readBody(req)).toString() || "{}").roster; } catch { /* bad body */ }
    res.end(JSON.stringify({ ...applyRoster(roster, { runtime: true }), enforced: !!meshMembers, count: meshMembers ? meshMembers.size : null }));
    return;
  }
  // Latest agent-eval results (scripts/agent_eval.mjs writes them) — the measured trust story.
  if (req.method === "GET" && req.url === "/api/eval") {
    res.writeHead(200, { "content-type": "application/json" });
    try { res.end(fs.readFileSync(path.join(import.meta.dirname, "..", "data", "agent_eval_results.json"), "utf8")); }
    catch { res.end("null"); }
    return;
  }
  // OpenAI-compatible shim so the web UI can run through the QVAC (or LM Studio) provider
  // with no frontend change — @qvac/sdk is a library, not a server, so we expose /v1 here.
  // Point Vite's /v1 proxy at this server (instead of LM Studio) to go fully on-device.
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body.toString() || "{}"); }
    catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "bad json" })); return; }
    const { messages = [], temperature, stream, encounterId } = parsed;
    const id = "chatcmpl-local";
    // Provider may not implement streaming -> fall back to one chunk from complete().
    const streamFn = provider.completeStream
      ? provider.completeStream.bind(provider)
      : async (h, o, onTok) => { const t = await provider.complete(h, o); onTok?.(t, "content"); return t; };
    let outContent = "", outReason = "";
    const t0 = Date.now();
    try {
      if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        await streamFn(messages, { temperature }, (tok, kind = "content") => {
          if (kind === "reasoning") outReason += tok; else outContent += tok;
          const delta = kind === "reasoning" ? { reasoning_content: tok } : { content: tok };
          send({ id, object: "chat.completion.chunk", model: provider.name, choices: [{ index: 0, delta }] });
        });
        send({ id, object: "chat.completion.chunk", model: provider.name, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const text = await provider.complete(messages, { temperature });
        outContent = text;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, object: "chat.completion", model: provider.name,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
      }
      // Raw model I/O audit (prompt + raw completion incl. reasoning), correlated by encounter.
      if (encounterId) audit.append(encounterId, "model.io",
        { model: provider.name, temperature: temperature ?? null, stream: !!stream,
          messages, content: outContent, reasoning: outReason || undefined, ms: Date.now() - t0 }, "model").catch(() => {});
    } catch (e) {
      if (res.headersSent) { try { res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`); } catch { /* ignore */ } res.end(); }
      else { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e) })); }
    }
    return;
  }
  if (req.method === "POST" && req.url === "/v1/embeddings") {
    const body = await readBody(req);
    try {
      const { input } = JSON.parse(body.toString() || "{}");
      const texts = Array.isArray(input) ? input : [input];
      const vecs = await provider.embed(texts);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", model: provider.name,
        data: vecs.map((embedding, index) => ({ object: "embedding", index, embedding })) }));
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: provider.name, object: "model" }] }));
    return;
  }
  // --- P2P audit handoff: device-to-device over Hyperswarm (see src/p2p.js) ---
  // POST /api/p2p/send {encounterId} -> {code,...}; POST /api/p2p/receive {code} -> import
  // result (held open until the transfer lands or times out); GET /api/p2p/status.
  if (req.url.split("?")[0].startsWith("/api/p2p")) {
    const action = req.url.split("?")[0].split("/").filter(Boolean)[2] || null;
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      const mod = await getP2p();
      if (req.method === "POST" && action === "send") {
        const { encounterId } = JSON.parse((await readBody(req)).toString() || "{}");
        json(200, await mod.offer(encounterId)); return;
      }
      if (req.method === "POST" && action === "receive") {
        const { code } = JSON.parse((await readBody(req)).toString() || "{}");
        json(200, await mod.receive(code)); return;
      }
      if (req.method === "POST" && action === "cancel") {
        const { code } = JSON.parse((await readBody(req)).toString() || "{}");
        json(200, await mod.cancel(code)); return;
      }
      if (req.method === "GET" && action === "status") { json(200, mod.status()); return; }
      json(404, { error: "unknown p2p route" });
    } catch (e) { json(400, { error: String(e?.message || e) }); }
    return;
  }
  // --- Audit log: per-encounter, append-only, hash-chained (see src/audit.js) ---
  if (req.url.split("?")[0].startsWith("/api/audit")) {
    const seg = req.url.split("?")[0].split("/").filter(Boolean); // ["api","audit", id?, action?]
    const id = seg[2] ? decodeURIComponent(seg[2]) : null;
    const action = seg[3] || null;
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === "POST" && seg[2] === "import") {            // POST /api/audit/import
        const b = JSON.parse((await readBody(req)).toString() || "{}");
        json(200, audit.importBundle(b)); return;
      }
      if (req.method === "POST" && !id) {                            // POST /api/audit  -> append
        const { encounterId, type, actor, data } = JSON.parse((await readBody(req)).toString() || "{}");
        const ev = await audit.append(encounterId, type, data || {}, actor || "system");
        json(200, { seq: ev.seq, hash: ev.hash, ts: ev.ts }); return;
      }
      if (req.method === "GET" && !id) { json(200, { encounters: audit.list() }); return; }   // list
      if (req.method === "GET" && id && action === "export") { json(200, audit.exportBundle(id)); return; }
      if (req.method === "GET" && id && action === "verify") { json(200, audit.verify(audit.read(id))); return; }
      // Lossy, human-readable OKF VIEW of an encounter (NOT the audit record — see
      // audit-okf.js). For OKF tooling; the signed bundle (export) stays authoritative.
      if (req.method === "GET" && id && action === "okf") {
        const files = encounterToOKF(id);
        if (!files) { json(404, { error: "no such encounter" }); return; }
        json(200, { encounterId: id, authoritative: false, files }); return;
      }
      if (req.method === "GET" && id) {                              // GET /api/audit/:id  -> events
        const events = audit.read(id);
        json(200, { encounterId: id, events, integrity: audit.verify(events) }); return;
      }
      json(404, { error: "unknown audit route" });
    } catch (e) { json(400, { error: String(e) }); }
    return;
  }
  // Clinical knowledge base: top passages from data/knowledge/*.md for a triage
  // conclusion (pharmacist reference — retrieved, cited, never auto-acted-on).
  if (req.method === "POST" && req.url === "/api/knowledge") {
    const body = await readBody(req);
    try {
      const { query, topK, encounterId } = JSON.parse(body.toString() || "{}");
      const results = await searchKnowledge(query || "", provider, Math.min(Math.max(Number(topK) || 3, 1), 8));
      if (encounterId) audit.append(encounterId, "knowledge.search",
        { query, results: results.map((r) => ({ doc: r.doc, score: r.score })) }, "system").catch(() => {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/icd") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { condition } = JSON.parse(body || "{}");
        const results = condition ? await verifyIcd(condition, provider, index, 3) : [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
    return;
  }
  // On-device TTS: POST {text, voice?, lang?} -> audio/wav
  // lang="yue" (or a "yue*" voice) routes to the Cantonese VITS voice.
  if (req.method === "POST" && req.url === "/api/tts") {
    const buf = await readBody(req);
    try {
      const { text, voice, lang } = JSON.parse(buf.toString() || "{}");
      const wav = await (await getSpeech()).synthesizeWav(text || "", { voice, lang });
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(wav);
    } catch (e) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `on-device TTS unavailable (@qvac/sdk + model): ${e}` }));
    }
    return;
  }
  // Selectable TTS voices (Kokoro): GET -> [{ id, name, language, gender, grade }]
  if (req.method === "GET" && req.url === "/api/tts/voices") {
    try {
      const voices = await (await getSpeech()).listVoices();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ voices }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ voices: [], error: String(e) }));
    }
    return;
  }
  // Agent: medpsy as a tool-calling loop (ICD grounding / knowledge / interactions),
  // separate from the scripted triage. POST {messages, encounterId} -> SSE stream of
  // {type: reasoning|tool_call|tool_result|answer|done|error}. Tools run on-device.
  if (req.method === "POST" && req.url === "/api/agent") {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body.toString() || "{}"); }
    catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "bad json" })); return; }
    const { messages = [], encounterId } = parsed;
    if (typeof provider.chatWithTools !== "function") {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `backend ${provider.name} has no tool-calling support` })); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    // Stop the (compute-heavy) loop if the client disconnects, and never write to a
    // closed socket — a stray res.write after close throws and would crash the handler.
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const send = (o) => { if (res.writableEnded || ac.signal.aborted) return; try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch { ac.abort(); } };
    try {
      const { runAgent } = await import("./agent.js");
      // Give the agent patient-aware memory: facts tools bound to this patient's log,
      // write-gated to "propose" (agent facts land low-confidence, pending confirmation).
      const factTools = encounterId
        ? [
            ...makeFactstoreTools(facts, { log: `patient:${encounterId}`, subject: `patient:${encounterId}`, allowWrite: "propose", recallStatus: "confirmed" }),
            makeInteractionTool(facts, { patientLog: `patient:${encounterId}`, kbLog: "kb:medical", kbStore }), // graph-grounded (federated/replicable)
          ]
        : [];
      await runAgent({
        provider, icdIndex: index, messages, signal: ac.signal, extraTools: [...factTools, ...consultTools],
        onEvent: (e) => {
          send(e);
          if (!encounterId) return;
          if (e.type === "tool_call") audit.append(encounterId, "agent.tool", { name: e.name, args: e.args }, "model").catch(() => {});
          else if (e.type === "answer") audit.append(encounterId, "agent.answer", { text: e.text }, "model").catch(() => {});
          else if (e.type === "tool_result") {
            // Pin decisions to the exact facts used: log the read receipt / written fact
            // into the tamper-evident encounter audit chain.
            const r = e.result || {};
            if (r.receipt) audit.append(encounterId, "facts.read", { tool: e.name, query: r.receipt.query, validAt: r.receipt.validAt, knownAt: r.receipt.knownAt, statements: r.receipt.statements }, "model").catch(() => {});
            if (r.recorded) audit.append(encounterId, "facts.assert", { tool: e.name, ...r.recorded }, "model").catch(() => {});
            if (e.name === "consult_peer") audit.append(encounterId, "consult.response", { answer: r.answer, peer: r.peer, signatureOk: r.signatureOk, error: r.error }, "model").catch(() => {});
          }
        },
      });
      send({ type: "done" });
    } catch (e) {
      send({ type: "error", error: String(e?.message || e) });
    }
    try { if (!res.writableEnded) { res.write("data: [DONE]\n\n"); res.end(); } } catch { /* socket already gone */ }
    return;
  }

  // Agentic triage — medpsy conducts the interview itself, grounding with the on-device
  // tools, and finishes by calling conclude (structured outcome). Separate from the scripted
  // 9-step triage. POST {encounterId, message, reset?} -> SSE {reasoning|tool_call|
  // tool_result|question|conclusion|done|error}. Conversation is held per encounter server-side.
  if (req.method === "POST" && req.url === "/api/agentic-triage") {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body.toString() || "{}"); }
    catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "bad json" })); return; }
    const { encounterId, message, reset, training } = parsed; // training mode = run the agent+gate but DON'T write to the real KB/signals/facts
    if (typeof provider.chatWithTools !== "function") {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `backend ${provider.name} has no tool-calling support` })); return;
    }
    if (!encounterId) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "encounterId required" })); return; }
    // One turn at a time per encounter: a concurrent POST (double-tap / retried fetch) would race
    // on the shared session — both spending the re-ask budget and clobbering session.messages.
    if (triageInFlight.has(encounterId)) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "a triage turn is already in progress for this encounter" })); return; }
    triageInFlight.add(encounterId);
    if (reset) triageSessions.delete(encounterId);
    const session = triageSessions.get(encounterId) || { messages: [] };
    triageSessions.set(encounterId, session);
    // Training runs are SIMULATIONS — they must touch NOTHING real: not facts/KB/signals (guarded
    // at conclusion) and not the tamper-evident audit. `aud` is a no-op in training, so a fake case
    // never appears as an encounter in the audit store. Real triage is unaffected.
    const aud = (type, data, who) => (training ? Promise.resolve() : audit.append(encounterId, type, data, who));
    if (message) {
      session.messages.push({ role: "user", content: String(message) });
      // The patient's utterance — same event type the kiosk logs, so a single encounter
      // chain reads uniformly across both flows.
      aud("message.user", { text: String(message) }, "patient").catch(() => {});
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const send = (o) => { if (res.writableEnded || ac.signal.aborted) return; try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch { ac.abort(); } };
    try {
      const { runTriageAgent } = await import("./triage-agent.js");
      const log = `patient:${encounterId}`;
      const extraTools = [
        ...makeFactstoreTools(facts, { log, subject: log, recallStatus: "confirmed" }), // read-only recall for grounding
        makeInteractionTool(facts, { patientLog: log, kbLog: "kb:medical", kbStore }),
        ...consultTools, // P2P second opinion from a paired clinician device, if configured
      ];
      // Pre-inject the patient's confirmed facts so the interview is patient-aware even if
      // the model doesn't call recall itself.
      let context = "";
      try {
        const pf = (await facts.fold(log, { status: "confirmed" })).facts;
        context = pf.map((f) => `- ${f.predicate}: ${typeof f.object === "object" ? JSON.stringify(f.object) : f.object}`).join("\n");
      } catch { /* no facts yet */ }
      // The safety reviewer may bounce the interview back for ONE more question per encounter
      // (bounded so it can never interrogate endlessly across turns), and — when a consult peer
      // is reachable and the case is escalating/uncertain — autonomously fetch a signed second
      // opinion over the mesh (advisory; can only raise the band).
      const MAX_SUPERVISOR_ASKS = 2;
      const consultFn = consultClient ? async ({ args, rationale }) => {
        if ((consultClient.peerCount?.() ?? 0) < 1) return null;
        const q = `Triage second opinion. Proposed disposition: ${args.decision} (severity ${args.severity}) for "${args.condition}". Red flags: ${args.redFlags || "none stated"}.${rationale ? ` Safety concern: ${rationale}.` : ""} Do you AGREE with this disposition, or would you escalate? Start your reply with AGREE or ESCALATE, then 1-2 sentences.`;
        try {
          const res = await consultClient.ask(q, { context: "" });
          const ans = String(res?.answer || "");
          // The prompt asks the peer to LEAD with AGREE or ESCALATE; trust that prefix first, then
          // fall back to a body scan. An empty/ambiguous answer → no escalation (safe: the gate can
          // only raise, so the worst case is "peer advice not applied", never a downgrade).
          const lead = ans.trim().slice(0, 16).toUpperCase();
          const escalate = /^ESCALAT/.test(lead) || (/\bescalat/i.test(ans) && !/^AGREE/.test(lead));
          const emergency = escalate && /\b999\b|\b911\b|anaphylax|emergency department|\bA&E\b|\bED\b|resus|ambulance|right away|immediately/i.test(ans);
          return { answer: ans, peer: res?.peer?.name || res?.peer?.publicKey?.slice(0, 12) || "peer", signatureOk: !!res?.signatureOk, escalate, emergency };
        } catch { return null; }
      } : null;
      const r = await runTriageAgent({
        provider, icdIndex: index, extraTools, context, messages: session.messages, signal: ac.signal,
        supervisorAsksLeft: Math.max(0, MAX_SUPERVISOR_ASKS - (session.supervisorAsks || 0)), consultFn,
        // EVERY step of the loop lands in the tamper-evident chain. The conversation layer
        // (message.user/message.assistant/outcome) and the facts layer (facts.read/.assert)
        // reuse the kiosk's event types so both flows are auditable the same way; the
        // agentic-only internals (private reasoning, raw tool I/O) use atriage.* types.
        onEvent: (e) => {
          send(e);
          if (e.type === "reasoning") aud("atriage.reasoning", { text: e.text }, "model").catch(() => {});
          else if (e.type === "critique") aud("atriage.critique", e.verdict, "model").catch(() => {});
          else if (e.type === "consult") aud("consult.response", { ...e.consult, trigger: "safety-gate" }, "model").catch(() => {});
          else if (e.type === "tool_call") aud("atriage.tool", { name: e.name, args: e.args }, "model").catch(() => {});
          else if (e.type === "tool_result") {
            // Pin grounding to the exact facts used: a factstore recall carries a receipt
            // (-> facts.read, as in /api/agent); other tools log their raw result.
            const r = e.result || {};
            if (r.receipt) aud("facts.read", { tool: e.name, query: r.receipt.query, validAt: r.receipt.validAt, knownAt: r.receipt.knownAt, statements: r.receipt.statements }, "model").catch(() => {});
            else if (e.name === "consult_peer") aud("consult.response", { answer: r.answer, peer: r.peer, signatureOk: r.signatureOk, error: r.error }, "model").catch(() => {});
            else aud("atriage.tool_result", { name: e.name, result: r }, "model").catch(() => {});
          }
          else if (e.type === "question") aud("message.assistant", { text: e.text, kind: "triage.question" }, "model").catch(() => {});
          else if (e.type === "error") aud("atriage.error", { error: e.error }, "model").catch(() => {});
          else if (e.type === "conclusion") {
            aud("outcome", e.outcome, "model").catch(() => {});
            // TRAINING mode: the agent + safety gate still run (that's the teaching value), but a
            // simulated case must NOT touch the real record — `aud` already no-op'd the audit above;
            // here we also skip the diagnosed-fact assert AND the federated co-occurrence tally.
            if (training) return;
            // Record the working diagnosis as a PROPOSED fact for the pharmacist to confirm,
            // and audit that assertion (statementId/hash) so the proposal is itself on-chain.
            facts.assert(log, { subject: log, predicate: "diagnosed", object: { name: e.outcome.condition, icd: e.outcome.icd },
              source: "triage", confidence: 0.6, meta: { proposed: true, band: e.outcome.band } })
              .then((rec) => audit.append(encounterId, "facts.assert", { tool: "triage.conclude", statementId: rec?.payload?.statementId, hash: rec?.hash, subject: log, predicate: "diagnosed", object: { name: e.outcome.condition, icd: e.outcome.icd }, proposed: true, confidence: 0.6 }, "model"))
              .catch(() => {});
            // Federated safety intelligence: tally de-identified co-occurrences of the patient's
            // meds, flagging the pair(s) when triage concluded with a concerning disposition.
            // PHI-free (drug names + counts only) — a crossed NETWORK threshold later auto-proposes
            // a candidate into the human-gated learning loop. Best-effort; never blocks the reply.
            (async () => {
              try {
                const meds = (await facts.fold(log, { predicate: "takes" })).facts
                  .map((f) => String(f.object?.ref || f.object?.name || "").replace(/^drug:/, "")).filter(Boolean);
                if (meds.length < 2) return;
                const adverse = /red|urgent|escalat|emergen|major|refer|999|a&e|ed\b/i.test(`${e.outcome.band || ""} ${e.outcome.disposition || ""} ${e.outcome.recommendation || ""}`);
                const meSig = identity.getIdentity().publicKey.slice(0, 12);
                for (let i = 0; i < meds.length; i++) for (let jj = i + 1; jj < meds.length; jj++)
                  await observeCooccurrence(kbStore, { a: meds[i], b: meds[jj], adverse, by: meSig }).catch(() => {});
                audit.append(encounterId, "signal.observe", { pairs: meds.length * (meds.length - 1) / 2, adverse, by: meSig }, "model").catch(() => {});
              } catch { /* signals best-effort */ }
            })();
          }
        },
      });
      if (r?.messages) session.messages = r.messages; // persist the conversation incl. tool turns
      if (r?.supervisorAsk) session.supervisorAsks = (session.supervisorAsks || 0) + 1; // spend the re-ask budget
      if (training) triageSessions.delete(encounterId); // don't accumulate one-shot training sessions
      send({ type: "done" });
    } catch (e) {
      send({ type: "error", error: String(e?.message || e) });
    } finally {
      triageInFlight.delete(encounterId); // release the per-encounter turn lock
    }
    try { if (!res.writableEnded) { res.write("data: [DONE]\n\n"); res.end(); } } catch { /* socket gone */ }
    return;
  }
  // Patient simulator for the Preceptor training flow — the model role-plays a patient from a
  // HIDDEN brief, answering only what the trainee asks. Pure simulation: backend-agnostic
  // (provider.complete), writes NOTHING (no facts/KB/signals/audit). POST {brief, turns:[{role,
  // content}], question} -> {reply}. Roles in `turns`: user = pharmacist question, assistant = patient.
  if (req.method === "POST" && req.url === "/api/patient-sim") {
    const buf = await readBody(req);
    try {
      const { brief, turns, question } = JSON.parse(buf.toString() || "{}");
      if (!brief || !question) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "brief and question required" })); return; }
      const sys = `You are ROLE-PLAYING a PATIENT at a community pharmacy, for a pharmacist's training exercise. Your situation (do NOT recite this as a list, and never name your own diagnosis):\n${String(brief).slice(0, 1500)}\n\nRules: answer ONLY what the pharmacist asks, in the first person, briefly (1-2 sentences), like a real worried-but-ordinary person. Do not volunteer extra symptoms unless asked. If asked about something not in your situation, give a plausible NORMAL/negative answer. Never break character, never give medical advice, never state the diagnosis.`;
      const history = [{ role: "system", content: sys }, ...(Array.isArray(turns) ? turns.slice(-12) : []), { role: "user", content: String(question).slice(0, 500) }];
      const raw = await provider.complete(history, { temperature: 0.6 });
      // medpsy sometimes RUNS ON past the patient's turn — leaking the system prompt or inventing a
      // next exchange. Keep only the patient's actual line(s): skip leading role/prompt echoes, then
      // stop at the first blank line or chat-role marker once real content has started.
      // A leak line is a chat-template / system-prompt echo — NOT ordinary speech. Anchored tightly
      // so a real reply like "You are right to ask, it started this morning" is NOT dropped.
      const isLeak = (l) => /^(you are (medpsy|role-?playing|a patient)|<\|)/i.test(l) || /^(user|assistant|system)\s*:?\s*$/i.test(l) || /^(patient|pharmacist)\s*:/i.test(l);
      const out = [];
      for (const l of stripThink(String(raw || "")).split("\n").map((x) => x.trim())) {
        if (!l || isLeak(l)) { if (out.length) break; else continue; } // blank/leak line ends the patient's turn
        out.push(l);
        if (out.join(" ").length > 240) break;
      }
      // If nothing survived (model returned only leakage), return a SAFE non-answer — never echo the
      // raw output, which could leak the hidden brief / system prompt.
      const reply = out.join(" ").trim().slice(0, 400) || "Sorry, I didn't catch that — could you ask me again?";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }
  // Warm the on-device speech models for a language ahead of use (called when the
  // language is chosen on the welcome step), so they're resident before anyone speaks.
  // POST {lang, voice} -> {ok}. Best-effort; never blocks the UI.
  if (req.method === "POST" && req.url === "/api/speech/prewarm") {
    const buf = await readBody(req);
    try {
      const { lang, voice } = JSON.parse(buf.toString() || "{}");
      (await getSpeech()).prewarmFor?.(lang, voice);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }
  // On-device STT: POST raw WAV bytes (16 kHz mono) -> {text, locale}
  // ?lang=yue routes Cantonese to SenseVoice; other langs transcribe Nemotron in that
  // locale. `locale` in the reply is what the model ACTUALLY used (auto if it fell back).
  if (req.method === "POST" && req.url.split("?")[0] === "/api/stt") {
    const buf = await readBody(req);
    const lang = new URL(req.url, "http://localhost").searchParams.get("lang") || undefined;
    const tmp = path.join(os.tmpdir(), `stt-${Date.now()}.wav`);
    try {
      fs.writeFileSync(tmp, buf);
      const { text, locale } = await (await getSpeech()).transcribe(tmp, { lang });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text, locale }));
    } catch (e) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `on-device STT unavailable (@qvac/sdk + model): ${e}` }));
    } finally {
      fs.existsSync(tmp) && fs.unlinkSync(tmp);
    }
    return;
  }
  // Bi-temporal fact store API (@qvac/factstore). GET fold/timeline/verify/export, POST
  // assert/end/correct/retract/import. Additive; the kiosk flow doesn't depend on it.
  // NB: unauthenticated like the rest of this server (CORS *) — a PHI read/write surface;
  // production needs auth + per-log access control before this is exposed beyond localhost.
  // Shared knowledge graph (the interaction graph), federated kiosk-to-kiosk over hyperswarm
  // — NO server. Share this device's graph (returns a key), join a peer's by key, read the
  // merged graph. PHI never travels here; only the authored interaction edges.
  if (req.url.split("?")[0].startsWith("/api/kb")) {
    const action = req.url.split("?")[0].split("/").filter(Boolean)[2] || null;
    const json = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    try {
      if (req.method === "GET" && !action) {
        const facts = (await kbStore.fold("kb:medical", { predicate: "interacts_with" })).facts;
        json(200, {
          count: facts.length, sharing: !!kbShare, key: kbShare?.keyHex || null,
          peers: kbPeers.map((p) => ({ key: p.key, importedAt: p.importedAt })),
          edges: facts.map((f) => ({ a: f.subject, b: f.object?.ref, severity: f.meta?.severity, note: f.meta?.note, source: f.source })),
        }); return;
      }
      if (req.method === "POST" && action === "share") {
        if (!kbShare) kbShare = await shareLog(kbAdapter, "kb:medical");
        json(200, { key: kbShare.keyHex }); return;
      }
      if (req.method === "POST" && action === "join") {
        const { key } = JSON.parse((await readBody(req)).toString() || "{}");
        if (!key || !/^[0-9a-f]{64}$/i.test(key)) { json(400, { error: "a 64-hex core key is required" }); return; }
        const r = await joinPeer(key);
        const total = (await kbStore.fold("kb:medical", { predicate: "interacts_with" })).facts.length;
        json(200, { ...r, total }); return;
      }
      if (req.method === "POST" && action === "sync") {
        let merged = 0;
        for (const p of kbPeers) merged += await mergePeerGraph(p.log).catch(() => 0);
        const count = (await kbStore.fold("kb:medical", { predicate: "interacts_with" })).facts.length;
        json(200, { peers: kbPeers.length, merged, count }); return;
      }
      if (req.method === "POST" && action === "leave") {
        const { key } = JSON.parse((await readBody(req)).toString() || "{}");
        const i = kbPeers.findIndex((p) => p.key === key);
        if (i === -1) { json(404, { error: "not a joined peer" }); return; }
        const [peer] = kbPeers.splice(i, 1);
        clearInterval(peer._timer);
        await peer.swarm?.destroy().catch(() => {});
        json(200, { left: peer.log }); return;
      }
      json(404, { error: "unknown kb route" });
    } catch (e) { json(400, { error: String(e?.message || e) }); }
    return;
  }
  // Edge learning — the privacy-preserving knowledge loop. Clinicians/agents PROPOSE candidate
  // interaction edges; medpsy adversarially VETS them; a clinician PROMOTES survivors into the
  // grounded, federated graph (or REJECTS). Every step is recorded in a tamper-evident
  // kb-learning audit chain. PHI never enters: an edge is two drugs + a generalized note.
  if (req.url.split("?")[0].startsWith("/api/learn")) {
    const action = req.url.split("?")[0].split("/").filter(Boolean)[2] || null;
    const q = new URL(req.url, "http://localhost").searchParams;
    const json = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const me = identity.getIdentity().publicKey.slice(0, 12);
    const body = async () => JSON.parse((await readBody(req)).toString() || "{}");
    try {
      // Would the agent flag this pair? (grounded = promoted; proposed candidates don't ground)
      if (req.method === "GET" && action === "check") {
        const a = drugId(q.get("a") || ""), b = drugId(q.get("b") || "");
        const e = (await kbStore.fold("kb:medical", { predicate: "interacts_with" })).facts
          .find((f) => (f.subject === a && f.object?.ref === b) || (f.subject === b && f.object?.ref === a));
        json(200, { a, b, exists: !!e, grounded: !!(e && !e.meta?.proposed), proposed: !!(e && e.meta?.proposed), severity: e?.meta?.severity || null, note: e?.meta?.note || null });
        return;
      }
      if (req.method === "GET" && !action) {
        const pending = await pendingEdges(kbStore);
        const all = (await kbStore.fold("kb:medical", { predicate: "interacts_with" })).facts;
        const promoted = all.filter((f) => f.meta?.learned && !f.meta?.proposed && String(f.subject) < String(f.object?.ref))
          .map((f) => ({ a: f.subject, b: f.object?.ref, severity: f.meta?.severity, note: f.meta?.note, by: f.meta?.promotedBy }));
        json(200, { pending, promoted }); return;
      }
      if (req.method === "POST" && action === "propose") {
        const { a, b, severity, note, evidence } = await body();
        const r = await proposeEdge(kbStore, { a, b, severity, note, contributedBy: me, evidence: evidence || "manual" });
        audit.append("kb-learning", "learn.propose", { id: r.id, a: r.a, b: r.b, severity: r.severity, by: me }, "clinician").catch(() => {});
        json(200, r); return;
      }
      if (req.method === "POST" && action === "vet") {
        const { edgeId } = await body();
        const e = (await pendingEdges(kbStore)).find((x) => x.id === edgeId);
        if (!e) { json(404, { error: "no such candidate edge" }); return; }
        // This kiosk's own medpsy votes.
        const verdict = await vetEdge(provider, e);
        await recordVote(kbStore, edgeId, { voter: "local", by: `local:${provider.name}`, real: verdict.real, severity: verdict.severity, reason: verdict.reason });
        audit.append("kb-learning", "learn.vet", { edgeId, real: verdict.real, severity: verdict.severity, by: `local:${provider.name}` }, "model").catch(() => {});
        // Peer-network vetting: EVERY paired kiosk's medpsy casts an independent, SIGNED vote (a jury).
        const peers = [];
        if (consultClient) {
          const jury = await consultClient.askVetAll({ a: e.a, b: e.b, severity: e.severity, note: e.note }).catch(() => []);
          for (const j of jury) {
            if (!isCountableVote(j, isMember)) continue; // only verified, allowlisted jurors count (src/membership.js)
            const p = { real: j.verdict.real, severity: j.verdict.severity, reason: j.verdict.reason, by: j.peer?.name || "peer", signatureOk: j.signatureOk };
            await recordVote(kbStore, edgeId, { voter: j.peer?.publicKey || `peer:${p.by}`, by: `peer:${p.by}`, real: p.real, severity: p.severity, reason: p.reason, signatureOk: p.signatureOk });
            audit.append("kb-learning", "learn.vet", { edgeId, real: p.real, severity: p.severity, by: `peer:${p.by}`, signatureOk: p.signatureOk }, "model").catch(() => {});
            peers.push(p);
          }
        }
        json(200, { local: verdict, peers }); return;
      }
      if (req.method === "POST" && action === "distill") {
        const { encounterId, correction = "", meds: medsIn } = await body();
        let meds = Array.isArray(medsIn) ? medsIn : [], transcript = "";
        if (encounterId) {
          try { meds = (await facts.fold(`patient:${encounterId}`, { predicate: "takes" })).facts.map((f) => String(f.object?.ref || f.object?.name || "").replace(/^drug:/, "")).filter(Boolean); } catch { /* no meds */ }
          // Feed the distiller only LOW-PHI structured signal (the triage outcome), NOT the
          // patient's raw utterances — so it can't echo patient specifics into a shared note.
          try { transcript = audit.read(encounterId).filter((e) => e.type === "outcome").map((e) => `outcome: ${e.data?.decision ?? ""} ${e.data?.condition ?? ""} ${e.data?.icd ?? ""}`).join("\n"); } catch { /* no transcript */ }
        }
        const { edges, error } = await distillEdges(provider, { meds, transcript, correction });
        const proposed = [];
        for (const ed of edges) {
          try { const r = await proposeEdge(kbStore, { ...ed, contributedBy: me, evidence: encounterId ? `enc:${String(encounterId).slice(0, 16)}` : "distill" }); if (!r.existing) proposed.push({ id: r.id, a: r.a, b: r.b, severity: ed.severity, note: ed.note }); }
          catch { /* already a known/seeded pair — skip */ }
        }
        audit.append("kb-learning", "learn.distill", { encounterId: encounterId || null, distilled: edges.length, proposed: proposed.map((p) => `${p.a}+${p.b}`), by: me }, "model").catch(() => {});
        json(200, { distilled: edges.length, proposed, error }); return;
      }
      if (req.method === "POST" && action === "promote") {
        const { edgeId, severity } = await body();
        const r = await promoteEdge(kbStore, edgeId, { by: `clinician:${me}`, severity });
        audit.append("kb-learning", "learn.promote", { edgeId, by: me }, "clinician").catch(() => {});
        json(200, r); return;
      }
      if (req.method === "POST" && action === "reject") {
        const { edgeId } = await body();
        const r = await rejectEdge(kbStore, edgeId);
        audit.append("kb-learning", "learn.reject", { edgeId, by: me }, "clinician").catch(() => {});
        json(200, r); return;
      }
      json(404, { error: "unknown learn route" });
    } catch (e) { json(400, { error: String(e?.message || e) }); }
    return;
  }
  // Federated safety intelligence — PHI-free pharmacovigilance (src/signals.js). Each kiosk
  // tallies de-identified drug-pair co-occurrences; the mesh sums them and a crossed threshold
  // auto-proposes a candidate into the human-gated vet/promote loop above.
  if (req.url.split("?")[0].startsWith("/api/signals")) {
    const action = req.url.split("?")[0].split("/").filter(Boolean)[2] || null;
    const json = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const me = identity.getIdentity().publicKey.slice(0, 12);
    const body = async () => JSON.parse((await readBody(req)).toString() || "{}");
    // Fold self + every replicated peer log directly (no re-mirroring → no double-count).
    const signalLogs = () => ["kb:medical", ...kbPeers.map((p) => p.log)];
    // Pairs that already exist as an interaction edge (proposed OR promoted) — don't re-propose.
    const knownPairs = async () => {
      const facts = (await kbStore.fold("kb:medical", { predicate: "interacts_with" })).facts;
      const s = new Set();
      for (const f of facts) { const pk = pairKey(String(f.subject).replace(/^drug:/, ""), String(f.object?.ref).replace(/^drug:/, "")); if (pk) s.add(pk); }
      return s;
    };
    try {
      // Record one (or more) de-identified co-occurrence(s). { drugs:[...], adverse:bool } bumps
      // every pair among the listed drugs; { a, b, adverse } bumps a single pair.
      if (req.method === "POST" && action === "observe") {
        const b = await body();
        const adverse = !!b.adverse;
        const recorded = [];
        if (Array.isArray(b.drugs) && b.drugs.length >= 2) {
          for (let i = 0; i < b.drugs.length; i++) for (let j = i + 1; j < b.drugs.length; j++) {
            try { recorded.push(await observeCooccurrence(kbStore, { a: b.drugs[i], b: b.drugs[j], adverse, by: me })); } catch { /* degenerate pair */ }
          }
        } else if (b.a && b.b) {
          recorded.push(await observeCooccurrence(kbStore, { a: b.a, b: b.b, adverse, by: me }));
        } else { json(400, { error: "need drugs[] (>=2) or a+b" }); return; }
        audit.append("kb-learning", "signal.observe", { pairs: recorded.map((r) => `${r.a}+${r.b}`), adverse, by: me }, "model").catch(() => {});
        json(200, { recorded, adverse }); return;
      }
      // Network status: the aggregate (self + peers), which pairs currently cross the threshold,
      // and this kiosk's own contribution. Read-only — does NOT propose.
      if (req.method === "GET" && !action) {
        const rows = await aggregateSignals(kbStore, { logs: signalLogs() });
        const crossing = detectSignals(rows, { knownPairs: await knownPairs() });
        json(200, { threshold: DEFAULT_THRESHOLD, contributors: 1 + kbPeers.length, aggregate: rows, crossing, me }); return;
      }
      // Scan: detect pairs crossing the threshold and AUTO-PROPOSE them into the vet/promote loop
      // (idempotent — already-known/proposed pairs are skipped). A human still vets + promotes.
      if (req.method === "POST" && action === "scan") {
        const rows = await aggregateSignals(kbStore, { logs: signalLogs() });
        const crossing = detectSignals(rows, { knownPairs: await knownPairs() });
        const proposed = await autoProposeSignals(crossing, (e) => proposeEdge(kbStore, { ...e, evidence: "federated-signal" }), { meId: me });
        for (const p of proposed) audit.append("kb-learning", "signal.propose", { id: p.id, a: p.a, b: p.b, severity: p.severity, seen: p.seen, flagged: p.flagged, contributors: p.contributors, by: me }, "model").catch(() => {});
        json(200, { crossing, proposed }); return;
      }
      json(404, { error: "unknown signals route" });
    } catch (e) { json(400, { error: String(e?.message || e) }); }
    return;
  }
  if (req.url.split("?")[0].startsWith("/api/facts")) {
    const seg = req.url.split("?")[0].split("/").filter(Boolean); // [api, facts, log?, action?]
    const log = seg[2] ? decodeURIComponent(seg[2]) : null;
    const action = seg[3] || null;
    const q = new URL(req.url, "http://localhost").searchParams;
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const opt = (k) => q.get(k) || undefined;
    try {
      if (req.method === "GET" && !log) { json(200, { logs: await facts.adapter.list() }); return; }
      if (req.method === "GET" && log && action === "timeline") { json(200, { timeline: await facts.timeline(log, { subject: opt("subject"), predicate: opt("predicate") }) }); return; }
      if (req.method === "GET" && log && action === "verify") { json(200, await facts.verify(log)); return; }
      if (req.method === "GET" && log && action === "export") { json(200, await facts.exportBundle(log)); return; }
      // OKF (Open Knowledge Format) export of a knowledge log — writes a real .md directory
      // the OKF visualizer/catalog can open, AND returns the bundle for the browser. Lossy
      // interchange (typed edges flatten to untyped links); the signed factstore bundle
      // (action=export) is the lossless, authoritative one.
      if (req.method === "GET" && log && action === "okf") {
        const files = await exportOKF(facts, { log });
        const dir = writeOKFDir(path.join(OKF_DIR, okfSlug(log)), files);
        json(200, { log, dir, count: Object.keys(files).length, files }); return;
      }
      if (req.method === "GET" && log) { json(200, await facts.fold(log, { subject: opt("subject"), predicate: opt("predicate"), validAt: opt("validAt"), knownAt: opt("knownAt"), status: opt("status") })); return; }
      if (req.method === "POST" && log && action === "import") { json(200, await facts.importBundle(JSON.parse((await readBody(req)).toString() || "{}"))); return; }
      // Import an OKF bundle ({ files: { "<path>.md": content } }) into a knowledge log.
      // Facts land source:"okf" (non-authoritative interchange provenance).
      if (req.method === "POST" && log && action === "okf-import") {
        const b = JSON.parse((await readBody(req)).toString() || "{}");
        json(200, await importOKF(b.files || {}, facts, { log, source: "okf", actor: "clinician" })); return;
      }
      if (req.method === "POST" && log) {
        const b = JSON.parse((await readBody(req)).toString() || "{}");
        const op = b.op || "assert";
        // Writes through this UNAUTHENTICATED endpoint are stamped non-authoritative
        // (source/actor "api") so a client can't forge a clinician/EHR-sourced fact that
        // would win conflict resolution; assert generates the statementId server-side so a
        // client can't rewrite an existing fact by colliding on its id. Trusted/clinical
        // writes must go through an authenticated, typed path (a lens), not this raw route.
        const stamp = { source: "api", actor: "api" };
        let r;
        if (op === "assert") r = await facts.assert(log, { ...b, ...stamp, statementId: undefined });
        else if (op === "end") r = await facts.end(log, b.statementId, b.validTo, stamp);
        else if (op === "correct") r = await facts.correct(log, b.statementId, { ...b, ...stamp });
        else if (op === "retract") r = await facts.retract(log, b.statementId, { ...b, ...stamp });
        else if (op === "confirm") r = await facts.confirm(log, b.statementId, { actor: "clinician" }); // promote an agent proposal
        else if (op === "reject") r = await facts.reject(log, b.statementId, { actor: "clinician" });
        else { json(400, { error: `unknown op '${op}'` }); return; }
        json(200, { statementId: r.payload.statementId, seq: r.seq, hash: r.hash }); return;
      }
      json(404, { error: "unknown facts route" });
    } catch (e) { json(400, { error: String(e?.message || e) }); }
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT);
