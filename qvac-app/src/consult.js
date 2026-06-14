// P2P "consult a colleague" — the agent reaches a paired senior-clinician device over
// Hyperswarm for a second opinion, NO cloud. Same transport/identity as the audit handoff
// (src/p2p.js, src/identity.js): both sides derive a DHT topic from a shared consult code,
// the request/response travel over Hyperswarm's end-to-end-encrypted Noise channel, and both
// messages are ed25519-signed so each side knows WHICH device it's talking to. The exchange
// is recorded in the encounter's tamper-evident audit chain by the server.
//
//   responder (clinician station):  await serveConsult(code, answerFn)   // answers, stays up
//   requester (kiosk agent):        const r = await consult(code, question)
import crypto from "node:crypto";
import Hyperswarm from "hyperswarm";
import b4a from "b4a";
import { getIdentity, sign, verify } from "./identity.js";

const RESPONSE_TIMEOUT_MS = Number(process.env.MEDPSY_CONSULT_TIMEOUT_MS) || 45 * 1000;
const BOOTSTRAP = process.env.MEDPSY_P2P_BOOTSTRAP
  ? process.env.MEDPSY_P2P_BOOTSTRAP.split(",").map((s) => { const [host, port] = s.split(":"); return { host, port: Number(port) }; })
  : undefined;

const normCode = (c) => (c || "").trim().toUpperCase();
const topicFor = (code) => crypto.createHash("sha256").update(`medpsy-consult:v1:${normCode(code)}`).digest();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Sign the id + a HASH of the text so the signature commits to the exact question/answer.
const reqSignable = (id, q) => `medpsy-consult-req:${id}:${sha(q)}`;
const resSignable = (id, a) => `medpsy-consult-res:${id}:${sha(a)}`;

function sendJson(conn, obj) { conn.write(JSON.stringify(obj) + "\n"); }
function onJsonLine(conn, cb) {
  let buf = "";
  conn.on("data", (chunk) => {
    buf += b4a.toString(chunk, "utf-8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      cb(msg);
    }
  });
}

// Responder: serve second opinions for `code`. answerFn(question, context) -> answer string
// (e.g. run the station's own medpsy with a senior-clinician prompt). Returns { swarm, … }.
// The signed payload for a request/response — a free-text question/answer OR a structured
// vet edge/verdict. Both sides hash the SAME payload so the signature commits to it.
const reqPayload = (msg) => (msg.vet ? JSON.stringify(msg.vet) : (msg.question || ""));
const resPayload = (msg) => (msg.verdict ? JSON.stringify(msg.verdict) : (msg.answer || ""));

// Responder: serve second opinions (answerFn) and/or structured edge VETS (vetFn) for `code`.
// answerFn(question, context) -> answer string; vetFn(edge) -> { real, severity, reason }.
export async function serveConsult(code, answerFn, { vetFn = null, bootstrap = BOOTSTRAP } = {}) {
  const swarm = new Hyperswarm({ bootstrap });
  swarm.on("connection", (conn) => {
    conn.on("error", () => {});
    onJsonLine(conn, async (msg) => {
      if (msg.kind !== "consult-request" || !msg.id) return;
      const fromOk = !!(msg.from?.publicKey && verify(reqSignable(msg.id, reqPayload(msg)), msg.sig || "", msg.from.publicKey));
      let out;
      if (msg.vet && vetFn) {
        let verdict; try { verdict = await vetFn(msg.vet, { from: msg.from, fromOk }); }
        catch (e) { verdict = { real: false, reason: `vet error: ${e?.message || e}` }; }
        out = { kind: "consult-response", id: msg.id, verdict };
      } else {
        let answer = ""; try { answer = String(await answerFn(msg.question || "", msg.context || "", { from: msg.from, fromOk })); }
        catch (e) { answer = `consult error: ${e?.message || e}`; }
        out = { kind: "consult-response", id: msg.id, answer };
      }
      sendJson(conn, { ...out, from: getIdentity(), sig: sign(resSignable(msg.id, resPayload(out))) });
    });
  });
  await swarm.join(topicFor(code), { server: true, client: false }).flushed();
  return { swarm, code, device: getIdentity() };
}

// One signed request/response round-trip. payload is { question } or { vet }. Resolves
// { answer?, verdict?, peer, signatureOk } or rejects on timeout.
function consultRaw(code, payload, { context = "", timeoutMs = RESPONSE_TIMEOUT_MS, bootstrap = BOOTSTRAP } = {}) {
  return new Promise((resolve, reject) => {
    const swarm = new Hyperswarm({ bootstrap });
    const id = crypto.randomBytes(8).toString("hex");
    let done = false;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); swarm.destroy().catch(() => {}); err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error("no peer answered the consult in time")), timeoutMs);
    swarm.on("connection", (conn) => {
      conn.on("error", () => {});
      const req = { kind: "consult-request", id, ...payload, context };
      sendJson(conn, { ...req, from: getIdentity(), sig: sign(reqSignable(id, reqPayload(req))) });
      onJsonLine(conn, (msg) => {
        if (msg.kind !== "consult-response" || msg.id !== id) return;
        const signatureOk = !!(msg.from?.publicKey && verify(resSignable(id, resPayload(msg)), msg.sig || "", msg.from.publicKey));
        finish(null, { answer: msg.answer, verdict: msg.verdict, peer: msg.from || null, signatureOk });
      });
    });
    swarm.join(topicFor(code), { server: false, client: true });
  });
}

// Requester: ask a peer one question, await a SIGNED answer.
export const consult = (code, question, opts = {}) =>
  consultRaw(code, { question }, opts).then((r) => ({ answer: r.answer || "", peer: r.peer, signatureOk: r.signatureOk }));

// Requester: ask a peer to VET a proposed interaction edge, await a SIGNED structured verdict.
export const consultVet = (code, edge, opts = {}) =>
  consultRaw(code, { vet: edge }, opts).then((r) => ({ verdict: r.verdict || { real: false, reason: "no verdict" }, peer: r.peer, signatureOk: r.signatureOk }));

// Agent tool: consult the paired clinician device for a second opinion. Bound into the agent
// toolset only when a consult code is configured (MEDPSY_CONSULT_CODE).
export function makeConsultTool(code) {
  return {
    def: { type: "function", function: {
      name: "consult_peer",
      description: "Consult a paired senior clinician's device (peer-to-peer, no cloud) for a second opinion on a difficult or ambiguous case. Returns their answer; the signed exchange is recorded in the audit. Use sparingly, for genuinely hard calls.",
      parameters: { type: "object", properties: {
        question: { type: "string", description: "the specific clinical question for the senior clinician" },
      }, required: ["question"] } } },
    run: async ({ question }) => {
      try { const r = await consult(code, question || ""); return { answer: r.answer, peer: r.peer, signatureOk: r.signatureOk }; }
      catch (e) { return { error: String(e?.message || e) }; }
    },
  };
}
