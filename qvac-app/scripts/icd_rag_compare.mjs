// A/B: @qvac/rag (ragIngest/ragSearch, HyperDB) vs our flat-cosine ICD lookup.
// Both use the SAME QVAC nomic embeddings, so this isolates the retrieval layer.
// Scores top-1 / top-3 exact ICD-10 match against the 20 curated ground-truth cases.
//
//   MEDPSY_BACKEND=qvac node scripts/icd_rag_compare.mjs
import fs from "node:fs";
import path from "node:path";
import { loadModel, embed, ragIngest, ragSearch, ragListWorkspaces, unloadModel } from "@qvac/sdk";
import { loadCodes } from "../src/icd.js";
import { loadOrBuildIndex, verifyIcd as cosineVerify } from "../src/icd-index.js"; // facade: current production backend
import { QVAC_EMBED_GGUF, DOC_PREFIX, QUERY_PREFIX } from "../src/config.js";

process.on("unhandledRejection", (e) => { console.error("UNHANDLED REJECTION:", e); process.exit(1); });
const ROOT = path.join(import.meta.dirname, "..", "..");
const cases = JSON.parse(fs.readFileSync(path.join(ROOT, "icd_cases.json"), "utf8")).cases;
const norm = (c) => (c || "").toUpperCase().replace(/\./g, "").trim();
const WS = "icd-eval";

console.log(`loading QVAC nomic embeddings (${path.basename(QVAC_EMBED_GGUF)})…`);
const modelId = await loadModel({ modelSrc: QVAC_EMBED_GGUF, modelType: "embeddings" });
const provider = {
  async embed(texts) {
    const { embedding } = await embed({ modelId, text: texts });
    return Array.isArray(embedding[0]) ? embedding : [embedding];
  },
};

// --- corpus + description->code map ---
const codes = loadCodes(); // [{code, description}]
const descToCode = new Map();
for (const c of codes) descToCode.set(c.description, c.code);

// --- ingest into @qvac/rag once (set RAG_INGEST=1; the HyperDB workspace persists on
// disk across runs, so scoring runs skip it by default). ---
const ws = await ragListWorkspaces().catch(() => ({ workspaces: [] }));
const have = !(process.env.RAG_INGEST === "1") || (ws.workspaces || []).find((w) => (w.name || w) === WS);
if (!have) {
  console.log(`ragIngest ${codes.length} ICD descriptions into workspace "${WS}" (one-time, slow)…`);
  await ragIngest({
    modelId,
    workspace: WS,
    chunk: false,
    documents: codes.map((c) => DOC_PREFIX + c.description),
    onProgress: (stage, cur, tot) => { if (cur % 2000 === 0 || cur === tot) process.stdout.write(`\r  [${stage}] ${cur}/${tot}   `); },
  });
  console.log("\ningest done");
} else {
  console.log(`workspace "${WS}" already ingested — reusing`);
}

// --- baseline cosine index (cached) ---
console.log("loading baseline ICD index…");
const index = await loadOrBuildIndex(provider);
console.log("baseline index ready; scoring 20 cases…");

// --- run both over the cases ---
const ragCodeOf = (content) => descToCode.get((content || "").replace(DOC_PREFIX, "").trim());
let cosTop1 = 0, cosTop3 = 0, ragTop1 = 0, ragTop3 = 0;
let cosMs = 0, ragMs = 0;
const rows = [];
for (const k of cases) {
  let t = performance.now();
  const cos = await cosineVerify(k.condition, provider, index, 3);
  cosMs += performance.now() - t;
  const cosCodes = cos.map((r) => norm(r.code));

  t = performance.now();
  const rag = await ragSearch({ modelId, workspace: WS, query: QUERY_PREFIX + k.condition, topK: 3 });
  ragMs += performance.now() - t;
  const ragResults = (rag.results || rag || []);
  const ragCodes = ragResults.map((r) => norm(ragCodeOf(r.content)));

  const exp = norm(k.expected_code);
  const c1 = cosCodes[0] === exp, c3 = cosCodes.includes(exp);
  const r1 = ragCodes[0] === exp, r3 = ragCodes.includes(exp);
  const ragTop1Content = (ragResults[0]?.content || "").replace(DOC_PREFIX, "").trim();
  const mapped = !!ragCodeOf(ragResults[0]?.content); // did top-1 content resolve to a code?
  cosTop1 += c1; cosTop3 += c3; ragTop1 += r1; ragTop3 += r3;
  rows.push({ id: k.id, cond: k.condition.slice(0, 28), exp: k.expected_code,
    cos: cosCodes[0], rag: ragCodes[0] || "(unmapped)", ragText: ragTop1Content.slice(0, 40), mapped,
    c1: c1 ? "✓" : c3 ? "~" : "✗", r1: r1 ? "✓" : r3 ? "~" : "✗" });
}
const unmapped = rows.filter((r) => !r.mapped).length;

const n = cases.length, pct = (x) => `${x}/${n} (${Math.round(100 * x / n)}%)`;
let out = "ICD lookup A/B — @qvac/rag (HyperDB) vs current cosine. Both use QVAC nomic embeddings.\n\n";
out += " id  condition                      expect   cosine    rag-top1   rag-content                              c r\n";
for (const r of rows)
  out += ` ${r.id.padEnd(3)} ${r.cond.padEnd(30)} ${String(r.exp).padEnd(8)} ${String(r.cos).padEnd(9)} ${String(r.rag).padEnd(10)} ${r.ragText.padEnd(40)} ${r.c1} ${r.r1}\n`;
out += `\ncurrent ICD   top1 ${pct(cosTop1)}  top3 ${pct(cosTop3)}  avg ${(cosMs / n).toFixed(1)}ms\n`;
out += `@qvac/rag     top1 ${pct(ragTop1)}  top3 ${pct(ragTop3)}  avg ${(ragMs / n).toFixed(1)}ms\n`;
out += `rag content->code unmapped: ${unmapped}/${n}  (if high, the gap is a mapping artifact; if low, it's real retrieval quality)\n`;
out += "(✓ top-1 exact · ~ in top-3 · ✗ miss)\n";
fs.writeFileSync("/tmp/icd_compare_report.txt", out);
console.log(out);

await unloadModel({ modelId });
process.exit(0);
