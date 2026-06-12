// Quality gate for the shared clinical knowledge base (GitHub-tracked "option B"):
// is @qvac/rag good enough for DOCUMENT retrieval (drug-interaction monographs, local
// protocols), even though it lost the ICD short-label A/B (5% vs 80%)?
//
// Three arms over data/knowledge/*.md + scripts/knowledge_cases.json, all using the
// SAME local QVAC nomic embeddings:
//   rag-naive : ragIngest(docs, chunk:true)             — as a naive integrator would
//   rag-tuned : ragChunk -> DOC_PREFIX per chunk -> ragIngest(chunk:false)
//               — rag's best shot (nomic prefixes applied per chunk)
//   cosine    : the SAME tuned chunks, flat normalized cosine in JS
// rag-tuned vs cosine isolates the retrieval layer with identical chunks.
//
// Scores doc-level recall@1 / recall@3 (did the top chunks come from the right doc).
//
//   node scripts/doc_rag_eval.mjs
import fs from "node:fs";
import path from "node:path";
import {
  loadModel, embed, unloadModel,
  ragChunk, ragIngest, ragSearch, ragDeleteWorkspace,
} from "@qvac/sdk";
import { QVAC_EMBED_GGUF, DOC_PREFIX, QUERY_PREFIX } from "../src/config.js";

process.on("unhandledRejection", (e) => { console.error("UNHANDLED REJECTION:", e); process.exit(1); });

const KNOW_DIR = path.join(import.meta.dirname, "..", "data", "knowledge");
const CASES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "knowledge_cases.json"), "utf8")).cases;
const docs = fs.readdirSync(KNOW_DIR).filter((f) => f.endsWith(".md"))
  .map((f) => ({ name: f, text: fs.readFileSync(path.join(KNOW_DIR, f), "utf8") }));
console.log(`corpus: ${docs.length} documents, ${CASES.length} ground-truth cases`);

console.log(`loading QVAC nomic embeddings (${path.basename(QVAC_EMBED_GGUF)})…`);
const modelId = await loadModel({ modelSrc: QVAC_EMBED_GGUF, modelType: "embeddings" });
const embedAll = async (texts) => {
  const out = [];
  for (const t of texts) {
    const { embedding } = await embed({ modelId, text: t });
    out.push(Array.isArray(embedding[0]) ? embedding[0] : embedding);
  }
  return out;
};

// Map a returned chunk back to its source doc by normalized substring containment.
const normText = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normedDocs = docs.map((d) => ({ name: d.name, norm: normText(d.text) }));
function docOf(chunkContent) {
  const c = normText(chunkContent.replace(DOC_PREFIX, ""));
  if (!c) return null;
  const hit = normedDocs.find((d) => d.norm.includes(c));
  if (hit) return hit.name;
  // chunker may join across paragraph boundaries — fall back to best word overlap
  const words = new Set(c.split(" "));
  let best = null, bestScore = 0;
  for (const d of normedDocs) {
    const dw = new Set(d.norm.split(" "));
    let n = 0;
    for (const w of words) if (dw.has(w)) n++;
    if (n / words.size > bestScore) { bestScore = n / words.size; best = d.name; }
  }
  return bestScore > 0.8 ? best : null;
}

const CHUNK_OPTS = { chunkStrategy: "paragraph", chunkSize: 256, chunkOverlap: 32 };

// --- shared tuned chunks (used by rag-tuned and cosine) ---
const tunedChunks = []; // { content, doc }
for (const d of docs) {
  const res = await ragChunk({ documents: d.text, chunkOpts: CHUNK_OPTS });
  const pieces = (res.chunks || res || []).map((c) => (typeof c === "string" ? c : c.content));
  for (const p of pieces) if (p && p.trim()) tunedChunks.push({ content: p, doc: d.name });
}
console.log(`tuned chunking: ${tunedChunks.length} chunks from ${docs.length} docs`);

// --- arm: rag-naive ---
const WS_NAIVE = "knowledge-naive", WS_TUNED = "knowledge-tuned";
await ragDeleteWorkspace({ workspace: WS_NAIVE }).catch(() => {});
await ragDeleteWorkspace({ workspace: WS_TUNED }).catch(() => {});
console.log("ragIngest (naive, chunk:true)…");
await ragIngest({ modelId, workspace: WS_NAIVE, chunk: true, chunkOpts: CHUNK_OPTS, documents: docs.map((d) => d.text) });
console.log("ragIngest (tuned, pre-chunked + DOC_PREFIX)…");
await ragIngest({ modelId, workspace: WS_TUNED, chunk: false, documents: tunedChunks.map((c) => DOC_PREFIX + c.content) });

// --- arm: cosine over the same tuned chunks ---
console.log("embedding tuned chunks for the cosine arm…");
const chunkVecs = await embedAll(tunedChunks.map((c) => DOC_PREFIX + c.content));
const l2 = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); };
const chunkUnit = chunkVecs.map(l2);
async function cosineSearch(query, topK) {
  const [qv] = await embedAll([QUERY_PREFIX + query]);
  const q = l2(qv);
  return chunkUnit
    .map((v, i) => ({ i, score: v.reduce((s, x, k) => s + x * q[k], 0) }))
    .sort((a, b) => b.score - a.score).slice(0, topK)
    .map((r) => ({ content: tunedChunks[r.i].content, doc: tunedChunks[r.i].doc, score: r.score }));
}

// --- score all arms ---
const arms = {
  "rag-naive": async (q) => (await ragSearch({ modelId, workspace: WS_NAIVE, query: QUERY_PREFIX + q, topK: 3 }))
    .map?.((r) => ({ doc: docOf(r.content) })) ?? [],
  "rag-tuned": async (q) => (await ragSearch({ modelId, workspace: WS_TUNED, query: QUERY_PREFIX + q, topK: 3 }))
    .map?.((r) => ({ doc: docOf(r.content) })) ?? [],
  "cosine": async (q) => (await cosineSearch(q, 3)).map((r) => ({ doc: r.doc })),
};

const scores = {}; const rows = [];
for (const name of Object.keys(arms)) scores[name] = { r1: 0, r3: 0, ms: 0 };
for (const k of CASES) {
  const row = { id: k.id, query: k.query.slice(0, 44), exp: k.doc };
  for (const [name, fn] of Object.entries(arms)) {
    const t = performance.now();
    let hits = [];
    try {
      const raw = await fn(k.query);
      hits = (raw.results || raw || []).map((r) => r.doc);
    } catch (e) { hits = [`ERR:${e.message}`]; }
    scores[name].ms += performance.now() - t;
    const r1 = hits[0] === k.doc, r3 = hits.slice(0, 3).includes(k.doc);
    scores[name].r1 += r1; scores[name].r3 += r3;
    row[name] = r1 ? "✓" : r3 ? "~" : `✗ ${String(hits[0] || "none").replace(/\.md$/, "").slice(0, 22)}`;
  }
  rows.push(row);
}

const n = CASES.length, pct = (x) => `${x}/${n} (${Math.round(100 * x / n)}%)`;
let out = "Doc-RAG quality gate — knowledge corpus retrieval (doc-level recall). Same QVAC nomic embeddings everywhere.\n\n";
out += " id   query                                         expect                                  naive       tuned       cosine\n";
for (const r of rows)
  out += ` ${r.id.padEnd(4)} ${r.query.padEnd(45)} ${r.exp.replace(/\.md$/, "").padEnd(39)} ${String(r["rag-naive"]).padEnd(11)} ${String(r["rag-tuned"]).padEnd(11)} ${r["cosine"]}\n`;
out += "\n";
for (const [name, s] of Object.entries(scores))
  out += `${name.padEnd(10)} recall@1 ${pct(s.r1)}   recall@3 ${pct(s.r3)}   avg ${(s.ms / n).toFixed(1)}ms\n`;
out += "(✓ top-1 doc correct · ~ in top-3 · ✗ miss, shows what came first)\n";
fs.writeFileSync("/tmp/doc_rag_report.txt", out);
console.log("\n" + out);

await unloadModel({ modelId });
process.exit(0);
