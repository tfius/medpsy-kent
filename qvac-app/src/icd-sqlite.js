// ICD-10 index backed by a real vector DB — SQLite-vector (@sqliteai/sqlite-wasm),
// QVAC's recommended bring-your-own vector store (the @qvac/rag path), replacing the
// hand-rolled cosine loop. Pattern follows packages/sdk/examples/rag/rag-sqlite.ts:
//   vector_as_f32 -> vector_init -> vector_quantize -> vector_quantize_scan (ANN search).
//
// We REUSE the embeddings already computed by the flat path (icd.js writes them to
// data/icd10.index.bin), so switching to the vector DB is just a different SEARCH —
// no re-embedding. Embeddings are normalized, so L2 distance ranks like cosine.
//
// Requires:  npm install @sqliteai/sqlite-wasm   (else the facade falls back to flat)

import { loadOrBuildIndex as loadEmbeddings, preferUnspecified } from "./icd.js";
import { QUERY_PREFIX } from "./config.js";

const normalize = (vec) => {
  let n = 0;
  for (const x of vec) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(vec, (x) => x / n);
};

export async function loadOrBuildIndex(provider, onProgress) {
  // 1) get embeddings (cached on disk by icd.js, or computed once)
  const { codes, matrix, dim } = await loadEmbeddings(provider, onProgress);

  // 2) load them into an in-memory SQLite-vector index
  const init = (await import("@sqliteai/sqlite-wasm")).default;
  const sqlite3 = await init();
  const db = new sqlite3.oo1.DB(":memory:", "c");
  db.exec("CREATE TABLE documents(id INTEGER PRIMARY KEY, code TEXT, text TEXT, embedding BLOB NOT NULL)");
  for (let i = 0; i < codes.length; i++) {
    const vec = Array.from(matrix.subarray(i * dim, (i + 1) * dim)); // already normalized
    db.exec({
      sql: "INSERT INTO documents VALUES (?,?,?,vector_as_f32(?))",
      bind: [i, codes[i].code, codes[i].description, JSON.stringify(vec)],
    });
  }
  db.exec(`SELECT vector_init('documents','embedding','type=FLOAT32,dimension=${dim}')`);
  db.exec(`SELECT vector_quantize('documents','embedding')`);
  return { db, codes, dim };
}

export async function verifyIcd(condition, provider, index, k = 3) {
  const { db } = index;
  const [raw] = await provider.embed([QUERY_PREFIX + condition]);
  const q = normalize(raw);
  const rows = [];
  db.exec({
    sql: `SELECT d.code, d.text, v.distance
          FROM documents d
          JOIN vector_quantize_scan('documents','embedding',vector_as_f32(?),12) v ON d.id = v.rowid`,
    bind: [JSON.stringify(q)],
    rowMode: "object",
    callback: (r) => rows.push(r),
  });
  // smaller distance = closer; convert to a descending "score" for the shared re-rank
  const ranked = rows
    .map((r) => ({ code: r.code, description: r.text, score: 1 / (1 + r.distance) }))
    .sort((a, b) => b.score - a.score);
  return preferUnspecified(condition, ranked).slice(0, k);
}
