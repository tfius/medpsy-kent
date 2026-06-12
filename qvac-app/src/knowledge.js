// On-device clinical knowledge base — drug-interaction monographs + local protocols
// (data/knowledge/*.md) retrieved per triage conclusion for the pharmacist.
//
// Retrieval is paragraph chunks + normalized cosine over provider embeddings. The
// doc-RAG quality gate (scripts/doc_rag_eval.mjs) picked cosine over @qvac/rag on
// identical chunks (cosine 83%/100% vs rag 75%/92% recall@1/@3), consistent with the
// ICD lookup decision. NB: the gate measured 256-token chunks; this module ships a
// coarser paragraph-merge chunker (chunkDoc below) — validated by smoke, not the gate.
// The corpus is plain markdown files, so distributing an updated protocol to other
// kiosks is a file transfer (see src/p2p.js), not a database migration.
//
// The chunk index (text + vectors) is cached at data/knowledge.index.json and
// rebuilt automatically when any document changes.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DOC_PREFIX, QUERY_PREFIX } from "./config.js";

const KNOW_DIR = process.env.MEDPSY_KNOWLEDGE_DIR || path.join(import.meta.dirname, "..", "data", "knowledge");
const CACHE_FILE = path.join(import.meta.dirname, "..", "data", "knowledge.index.json");
const TARGET_CHUNK_CHARS = 1100; // merge paragraphs up to roughly this size

// Split a markdown doc into paragraph groups: blank-line separated blocks, merged
// until the target size so each chunk keeps enough context to stand alone.
export function chunkDoc(text) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = "";
  for (const p of paras) {
    if (cur && (cur.length + p.length) > TARGET_CHUNK_CHARS) { chunks.push(cur); cur = p; }
    else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function readCorpus() {
  let files = [];
  try { files = fs.readdirSync(KNOW_DIR).filter((f) => f.endsWith(".md")).sort(); }
  catch { return { chunks: [], hash: "empty" }; }
  const chunks = []; // { doc, content }
  const h = crypto.createHash("sha256");
  for (const f of files) {
    const text = fs.readFileSync(path.join(KNOW_DIR, f), "utf8");
    h.update(f).update("\0").update(text).update("\0");
    for (const content of chunkDoc(text)) chunks.push({ doc: f, content });
  }
  return { chunks, hash: h.digest("hex") };
}

const l2 = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); };

// The cache key must cover BOTH the corpus and the embedder: vectors from one
// provider are meaningless against another's query vectors (different space, maybe
// different dimension). Re-keying on a provider change forces a rebuild.
const keyFor = (provider, hash) => `${provider?.name || "?"}::${hash}`;

let cache = null;    // { key, index } — last built index, in memory
let building = null; // { key, promise } — in-flight build (dedups concurrent callers)

// Load (or build) the chunk index for the CURRENT corpus + provider. Re-reading the
// (small) corpus on each call means a dropped-in document is picked up without a
// restart; embedding only re-runs when the corpus or embedder actually changes.
export function loadOrBuildKnowledge(provider, onProgress) {
  const { chunks, hash } = readCorpus();
  const key = keyFor(provider, hash);
  if (cache && cache.key === key) return Promise.resolve(cache.index);
  if (building && building.key === key) return building.promise;
  const promise = build(provider, chunks, hash, key, onProgress)
    .then((index) => { cache = { key, index }; building = null; return index; })
    .catch((e) => { building = null; throw e; });
  building = { key, promise };
  return promise;
}

async function build(provider, chunks, hash, key, onProgress) {
  if (!chunks.length) return { key, hash, chunks: [] };
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (cached.key === key && cached.chunks?.length === chunks.length) return cached;
  } catch { /* no cache yet */ }
  // embed() takes an array — one batched call beats N sequential round-trips.
  const vecs = (await provider.embed(chunks.map((c) => DOC_PREFIX + c.content))).map(l2);
  onProgress?.(chunks.length, chunks.length);
  const index = { key, hash, builtAt: new Date().toISOString(), chunks: chunks.map((c, i) => ({ ...c, vec: vecs[i] })) };
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(index));
  return index;
}

// Top-K passages for a query. Returns [{doc, content, score}] best-first.
export async function searchKnowledge(query, provider, topK = 3) {
  const index = await loadOrBuildKnowledge(provider);
  if (!index.chunks.length || !(query || "").trim()) return [];
  const [qv] = await provider.embed([QUERY_PREFIX + query]);
  const q = l2(qv);
  return index.chunks
    .map((c) => ({ doc: c.doc, content: c.content, score: c.vec.reduce((s, x, k) => s + x * q[k], 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 }));
}
