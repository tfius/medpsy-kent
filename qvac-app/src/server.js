// Tiny ICD-10 grounding API for the web UI. Reuses our verified lookup (icd-index.js)
// + provider embeddings. No external deps on the LM Studio path (built-in http/fetch).
//   node src/server.js          # serves POST /api/icd {condition} -> verified code(s)
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
import { proposeEdge, vetEdge, recordVote, promoteEdge, rejectEdge, pendingEdges, distillEdges } from "./edge-learning.js";
import { seedInteractions, makeInteractionTool, drugId } from "./medlens.js";
import { encounterToOKF } from "./audit-okf.js";
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

// P2P "consult a colleague" — when a consult code is configured, the agent gets a tool to
// reach a paired senior-clinician device for a second opinion (src/consult.js). No cloud.
const CONSULT_CODE = process.env.MEDPSY_CONSULT_CODE || null;
// One persistent consult swarm per kiosk: it ASKS peers (the jury / second opinion) AND
// ANSWERS them (so every kiosk is a juror — it vets peers' edges with its own medpsy). The
// client ignores its own pubkey, so a kiosk never votes on its own edge.
const CONSULT_SYS = "You are a SENIOR clinician giving a brief second opinion to a community pharmacist's triage assistant. 2-4 sentences: red flags, safest disposition, anything to add. Advisory.";
const consultClient = CONSULT_CODE ? createConsultClient(CONSULT_CODE, {
  answerFn: async (q, ctx) => (await provider.complete([{ role: "system", content: CONSULT_SYS }, { role: "user", content: ctx ? `${q}\n\nContext: ${ctx}` : q }], { temperature: 0.3 })).trim(),
  vetFn: async (edge) => (await import("./edge-learning.js")).vetEdge(provider, edge),
}) : null;
const consultTools = consultClient ? [makeConsultTool(consultClient)] : [];
if (CONSULT_CODE) console.log(`[consult] peer-consult enabled (code "${CONSULT_CODE}") — this kiosk asks AND answers (juror)`);

// Agentic-triage conversations, kept per encounter (in-memory; a kiosk session is short).
const triageSessions = new Map(); // encounterId -> { messages: [] }

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
      model: onDevice ? QVAC_LLM_GGUF : `${LMSTUDIO_LLM} @ ${LMSTUDIO_URL}`,
      note: onDevice
        ? "All inference runs on this device via @qvac/sdk (local .gguf) — no cloud, no outbound model calls."
        : "Dev backend: LM Studio's local server on this machine (not cloud, but not the on-device QVAC path).",
    }));
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
    const { encounterId, message, reset } = parsed;
    if (typeof provider.chatWithTools !== "function") {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `backend ${provider.name} has no tool-calling support` })); return;
    }
    if (!encounterId) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "encounterId required" })); return; }
    if (reset) triageSessions.delete(encounterId);
    const session = triageSessions.get(encounterId) || { messages: [] };
    triageSessions.set(encounterId, session);
    if (message) {
      session.messages.push({ role: "user", content: String(message) });
      // The patient's utterance — same event type the kiosk logs, so a single encounter
      // chain reads uniformly across both flows.
      audit.append(encounterId, "message.user", { text: String(message) }, "patient").catch(() => {});
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
      const r = await runTriageAgent({
        provider, icdIndex: index, extraTools, context, messages: session.messages, signal: ac.signal,
        // EVERY step of the loop lands in the tamper-evident chain. The conversation layer
        // (message.user/message.assistant/outcome) and the facts layer (facts.read/.assert)
        // reuse the kiosk's event types so both flows are auditable the same way; the
        // agentic-only internals (private reasoning, raw tool I/O) use atriage.* types.
        onEvent: (e) => {
          send(e);
          if (e.type === "reasoning") audit.append(encounterId, "atriage.reasoning", { text: e.text }, "model").catch(() => {});
          else if (e.type === "tool_call") audit.append(encounterId, "atriage.tool", { name: e.name, args: e.args }, "model").catch(() => {});
          else if (e.type === "tool_result") {
            // Pin grounding to the exact facts used: a factstore recall carries a receipt
            // (-> facts.read, as in /api/agent); other tools log their raw result.
            const r = e.result || {};
            if (r.receipt) audit.append(encounterId, "facts.read", { tool: e.name, query: r.receipt.query, validAt: r.receipt.validAt, knownAt: r.receipt.knownAt, statements: r.receipt.statements }, "model").catch(() => {});
            else if (e.name === "consult_peer") audit.append(encounterId, "consult.response", { answer: r.answer, peer: r.peer, signatureOk: r.signatureOk, error: r.error }, "model").catch(() => {});
            else audit.append(encounterId, "atriage.tool_result", { name: e.name, result: r }, "model").catch(() => {});
          }
          else if (e.type === "question") audit.append(encounterId, "message.assistant", { text: e.text, kind: "triage.question" }, "model").catch(() => {});
          else if (e.type === "error") audit.append(encounterId, "atriage.error", { error: e.error }, "model").catch(() => {});
          else if (e.type === "conclusion") {
            audit.append(encounterId, "outcome", e.outcome, "model").catch(() => {});
            // Record the working diagnosis as a PROPOSED fact for the pharmacist to confirm,
            // and audit that assertion (statementId/hash) so the proposal is itself on-chain.
            facts.assert(log, { subject: log, predicate: "diagnosed", object: { name: e.outcome.condition, icd: e.outcome.icd },
              source: "triage", confidence: 0.6, meta: { proposed: true, band: e.outcome.band } })
              .then((rec) => audit.append(encounterId, "facts.assert", { tool: "triage.conclude", statementId: rec?.payload?.statementId, hash: rec?.hash, subject: log, predicate: "diagnosed", object: { name: e.outcome.condition, icd: e.outcome.icd }, proposed: true, confidence: 0.6 }, "model"))
              .catch(() => {});
          }
        },
      });
      if (r?.messages) session.messages = r.messages; // persist the conversation incl. tool turns
      send({ type: "done" });
    } catch (e) {
      send({ type: "error", error: String(e?.message || e) });
    }
    try { if (!res.writableEnded) { res.write("data: [DONE]\n\n"); res.end(); } } catch { /* socket gone */ }
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
        if (kbPeers.some((p) => p.key === key)) { json(200, { joined: false, reason: "already joined" }); return; }
        const peerLog = `kb:peer:${key.slice(0, 12)}`;
        const { swarm } = await joinLog(kbAdapter, peerLog, key);
        const imported = await mergePeerGraph(peerLog);
        const peer = { key, log: peerLog, swarm, importedAt: new Date().toISOString() };
        kbPeers.push(peer);
        // Keep folding in the peer's LIVE additions (the demo's point) on a light interval.
        peer._timer = setInterval(() => mergePeerGraph(peerLog).catch(() => {}), 15000);
        const total = (await kbStore.fold("kb:medical", { predicate: "interacts_with" })).facts.length;
        json(200, { joined: peerLog, imported, total }); return;
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
