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

// Requester: ask EVERY available peer on the topic to vet an edge, collecting their signed
// verdicts — a jury. Resolves to an array of { verdict, peer, signatureOk } (one per device),
// after a short settle window past the first vote (or maxPeers / the overall timeout). Never
// rejects — an empty array means no peer was reachable.
export function consultVetAll(code, edge, { timeoutMs = 15000, collectMs = 6000, maxPeers = 12, bootstrap = BOOTSTRAP } = {}) {
  return new Promise((resolve) => {
    const swarm = new Hyperswarm({ bootstrap });
    const id = crypto.randomBytes(8).toString("hex");
    const votes = [], seen = new Set();
    let done = false, settle = null;
    const finish = () => { if (done) return; done = true; clearTimeout(overall); clearTimeout(settle); swarm.destroy().catch(() => {}); resolve(votes); };
    const overall = setTimeout(finish, timeoutMs);
    swarm.on("connection", (conn) => {
      conn.on("error", () => {});
      const req = { kind: "consult-request", id, vet: edge };
      sendJson(conn, { ...req, from: getIdentity(), sig: sign(reqSignable(id, reqPayload(req))) });
      onJsonLine(conn, (msg) => {
        if (msg.kind !== "consult-response" || msg.id !== id || !msg.verdict) return;
        const pub = msg.from?.publicKey;
        if (!pub || pub === getIdentity().publicKey || seen.has(pub)) return; // one vote per device; never self
        seen.add(pub);
        votes.push({ verdict: msg.verdict, peer: msg.from || null, signatureOk: !!verify(resSignable(id, resPayload(msg)), msg.sig || "", pub) });
        if (votes.length >= maxPeers) return finish();
        clearTimeout(settle); settle = setTimeout(finish, collectMs); // wait a bit for more jurors
      });
    });
    swarm.join(topicFor(code), { server: false, client: true });
  });
}

// A PERSISTENT consult peer — joins the topic ONCE (as both server and client when vetFn/
// answerFn are given) and keeps connections warm. One swarm per kiosk: it ANSWERS peers'
// requests (so every kiosk is a juror) AND asks its own — no self-connection, no per-call DHT
// discovery. `ask` returns the first signed answer; `askVetAll` collects the jury.
// `announce` (a string, e.g. this kiosk's KB core key) is gossiped to every peer on connect;
// `onAnnounce(value, from)` fires for each peer's announce — used to auto-discover the mesh
// (a kiosk learns peers' KB keys over the same swarm and joins their graphs).
export function createConsultClient(code, { vetFn = null, answerFn = null, announce = null, onAnnounce = null, bootstrap = BOOTSTRAP } = {}) {
  const serves = !!(vetFn || answerFn);
  const swarm = new Hyperswarm({ bootstrap });
  const conns = new Set();
  const pending = new Map(); // request id -> (msg) => void
  const active = new Map();  // request id -> wire (in-flight, replayed to peers that join late)
  async function serve(conn, msg) {
    let out;
    if (msg.vet && vetFn) { let verdict; try { verdict = await vetFn(msg.vet, { from: msg.from }); } catch (e) { verdict = { real: false, reason: `vet error: ${e?.message || e}` }; } out = { kind: "consult-response", id: msg.id, verdict }; }
    else if (answerFn) { let answer = ""; try { answer = String(await answerFn(msg.question || "", msg.context || "", { from: msg.from })); } catch (e) { answer = `consult error: ${e?.message || e}`; } out = { kind: "consult-response", id: msg.id, answer }; }
    else return;
    try { sendJson(conn, { ...out, from: getIdentity(), sig: sign(resSignable(msg.id, resPayload(out))) }); } catch { /* dead conn */ }
  }
  swarm.on("connection", (conn) => {
    conn.on("error", () => {});
    conn.on("close", () => conns.delete(conn));
    conns.add(conn);
    onJsonLine(conn, (msg) => {
      if (msg.kind === "consult-response" && pending.has(msg.id)) pending.get(msg.id)(msg);
      else if (msg.kind === "consult-request" && msg.id && serves) serve(conn, msg);
      else if (msg.kind === "kb-announce" && onAnnounce && msg.key) {
        // The signature proves the announcer owns `from.publicKey` AND committed to this key —
        // so membership (allowlist) decisions can trust `from`. Pass fromOk to the policy.
        const fromOk = !!(msg.from?.publicKey && verify(`kb-announce:${msg.key}`, msg.sig || "", msg.from.publicKey));
        onAnnounce(msg.key, msg.from, fromOk);
      }
    });
    announceTo(conn);
    for (const wire of active.values()) { try { sendJson(conn, wire); } catch { /* dead conn */ } } // catch late jurors
  });
  const announceTo = (conn) => { if (announce) { try { sendJson(conn, { kind: "kb-announce", key: announce, from: getIdentity(), sig: sign(`kb-announce:${announce}`) }); } catch { /* dead conn */ } } };

  // SELF-HEALING discovery: two peers that join at the same instant can miss each other's first
  // lookup (a star forms around whoever joined last), and a connection can drop a kb-announce.
  // So we (a) re-run discovery on an escalating-then-steady cadence to keep finding peers, and
  // (b) re-announce our key to all current conns each tick (heals a missed announce). Cheap.
  const disc = swarm.join(topicFor(code), { server: serves, client: true });
  disc.flushed().catch(() => {});
  let healTimer = null, tries = 0;
  const heal = () => {
    try { disc.refresh?.({ client: true, server: serves }); } catch { /* ignore */ }
    for (const c of conns) announceTo(c);
    tries++;
    healTimer = setTimeout(heal, tries < 5 ? 4000 + tries * 2000 : 30000); // 6,8,10,12s → then every 30s
  };
  healTimer = setTimeout(heal, 3000);

  const waitForConn = (ms) => conns.size ? Promise.resolve(true) : new Promise((res) => {
    const t = setTimeout(() => { swarm.off("connection", h); res(false); }, ms);
    const h = () => { clearTimeout(t); res(true); };
    swarm.once("connection", h);
  });
  const broadcast = (req) => {
    const wire = { ...req, from: getIdentity(), sig: sign(reqSignable(req.id, reqPayload(req))) };
    active.set(req.id, wire);
    for (const c of conns) { try { sendJson(c, wire); } catch { /* dead conn */ } }
  };
  const settle = (id) => { pending.delete(id); active.delete(id); };

  return {
    async ask(question, { context = "", timeoutMs = RESPONSE_TIMEOUT_MS } = {}) {
      await waitForConn(Math.min(timeoutMs, 12000));
      if (!conns.size) throw new Error("no peer connected");
      return new Promise((resolve, reject) => {
        const id = crypto.randomBytes(8).toString("hex");
        let done = false;
        const fin = (err, val) => { if (done) return; done = true; clearTimeout(t); settle(id); err ? reject(err) : resolve(val); };
        const t = setTimeout(() => fin(new Error("no peer answered the consult in time")), timeoutMs);
        pending.set(id, (msg) => {
          const pub = msg.from?.publicKey;
          if (!pub || pub === getIdentity().publicKey) return; // ignore self; wait for a real peer
          fin(null, { answer: msg.answer || "", peer: msg.from || null, signatureOk: !!verify(resSignable(id, resPayload(msg)), msg.sig || "", pub) });
        });
        broadcast({ kind: "consult-request", id, question, context });
      });
    },
    async askVetAll(edge, { timeoutMs = 12000, collectMs = 5000, maxPeers = 12 } = {}) {
      await waitForConn(Math.min(timeoutMs, 10000));
      return new Promise((resolve) => {
        const id = crypto.randomBytes(8).toString("hex");
        const votes = [], seen = new Set();
        let done = false, settleTimer = null;
        const fin = () => { if (done) return; done = true; clearTimeout(overall); clearTimeout(settleTimer); settle(id); resolve(votes); };
        const overall = setTimeout(fin, timeoutMs);
        if (!conns.size) return fin();
        pending.set(id, (msg) => {
          if (!msg.verdict) return;
          const pub = msg.from?.publicKey;
          if (!pub || pub === getIdentity().publicKey || seen.has(pub)) return; // one vote per device; never self
          seen.add(pub);
          votes.push({ verdict: msg.verdict, peer: msg.from || null, signatureOk: !!verify(resSignable(id, resPayload(msg)), msg.sig || "", pub) });
          if (votes.length >= maxPeers) return fin();
          clearTimeout(settleTimer); settleTimer = setTimeout(fin, collectMs);
        });
        broadcast({ kind: "consult-request", id, vet: edge });
      });
    },
    peerCount: () => conns.size,
    close() { clearTimeout(healTimer); return swarm.destroy().catch(() => {}); },
  };
}

// Agent tool: consult the paired clinician device for a second opinion. Uses a persistent
// consult client (createConsultClient) so the round-trip is warm.
export function makeConsultTool(client) {
  return {
    def: { type: "function", function: {
      name: "consult_peer",
      description: "Consult a paired senior clinician's device (peer-to-peer, no cloud) for a second opinion on a difficult or ambiguous case. Returns their answer; the signed exchange is recorded in the audit. Use sparingly, for genuinely hard calls.",
      parameters: { type: "object", properties: {
        question: { type: "string", description: "the specific clinical question for the senior clinician" },
      }, required: ["question"] } } },
    run: async ({ question }) => {
      try { const r = await client.ask(question || ""); return { answer: r.answer, peer: r.peer, signatureOk: r.signatureOk }; }
      catch (e) { return { error: String(e?.message || e) }; }
    },
  };
}
