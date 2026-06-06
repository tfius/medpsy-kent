// ICD index facade. ICD_INDEX selects the search backend:
//   sqlite (default) -> SQLite-vector ANN (@qvac/rag style; needs @sqliteai/sqlite-wasm)
//   flat             -> in-process cosine (no extra deps; always works)
// If the sqlite backend can't load (package not installed), it falls back to flat,
// so the app runs either way.

let impl = null;

export async function loadOrBuildIndex(provider, onProgress) {
  const want = process.env.ICD_INDEX || "sqlite";
  if (want === "sqlite") {
    try {
      impl = await import("./icd-sqlite.js");
      const index = await impl.loadOrBuildIndex(provider, onProgress);
      console.error("[icd] backend: sqlite-vector (@qvac/rag style)");
      return index;
    } catch (e) {
      console.error(`[icd] sqlite-vector unavailable -> flat cosine (${e.message})`);
    }
  }
  impl = await import("./icd.js");
  console.error("[icd] backend: flat cosine");
  return impl.loadOrBuildIndex(provider, onProgress);
}

export function verifyIcd(condition, provider, index, k) {
  return impl.verifyIcd(condition, provider, index, k);
}
