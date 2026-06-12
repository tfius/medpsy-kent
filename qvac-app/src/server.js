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

// Warm the on-device STT model now so the first dictation isn't "stuck" loading.
getSpeech().then((sp) => { sp.prewarmStt?.(); sp.prewarmTts?.(); }).catch(() => {});

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
  // On-device STT: POST raw WAV bytes (16 kHz mono) -> {text}
  // ?lang=yue routes Cantonese to SenseVoice; other langs use the Nemotron chain.
  if (req.method === "POST" && req.url.split("?")[0] === "/api/stt") {
    const buf = await readBody(req);
    const lang = new URL(req.url, "http://localhost").searchParams.get("lang") || undefined;
    const tmp = path.join(os.tmpdir(), `stt-${Date.now()}.wav`);
    try {
      fs.writeFileSync(tmp, buf);
      const text = await (await getSpeech()).transcribe(tmp, { lang });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text }));
    } catch (e) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `on-device STT unavailable (@qvac/sdk + model): ${e}` }));
    } finally {
      fs.existsSync(tmp) && fs.unlinkSync(tmp);
    }
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT);
