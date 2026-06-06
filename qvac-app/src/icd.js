// ICD-10 grounding via on-device embeddings (provider-agnostic).
//
// medpsy hallucinates ICD-10 codes (measured ~15% exact, ~30% invalid — see ../README).
// Fix: embed the official ICD-10 descriptions once, cache the vectors locally, then map
// the model's named CONDITION -> nearest verified code by cosine. Same approach as the
// repo's Python icd_lookup.py. The `provider.embed()` runs on LM Studio today or the QVAC
// SDK later — identical logic. (@qvac/rag's ragIngest/ragSearch is the managed-DB upgrade.)

import fs from "node:fs";
import path from "node:path";
import { DOC_PREFIX, QUERY_PREFIX } from "./config.js";

const DATA = path.join(import.meta.dirname, "..", "data");
const CODES_FILE = path.join(DATA, "icd10.json");
const INDEX_BIN = path.join(DATA, "icd10.index.bin");
const INDEX_META = path.join(DATA, "icd10.index.meta.json");
const GENERIC = ["unspecified", "not specified", ", nos", "site not specified"];

export const loadCodes = () => JSON.parse(fs.readFileSync(CODES_FILE, "utf8")); // [{code, description}]

function normalize(vec) {
  let n = 0;
  for (const x of vec) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(vec, (x) => x / n);
}

// Build the index once (slow: embeds ~12k descriptions), then cache to disk.
export async function buildIndex(provider, onProgress) {
  const codes = loadCodes();
  const texts = codes.map((c) => DOC_PREFIX + c.description);
  let dim = 0, matrix = null;
  const batch = 64;
  for (let i = 0; i < texts.length; i += batch) {
    const vecs = await provider.embed(texts.slice(i, i + batch)); // number[][]
    if (!matrix) { dim = vecs[0].length; matrix = new Float32Array(codes.length * dim); }
    vecs.forEach((v, j) => matrix.set(normalize(v), (i + j) * dim));
    onProgress?.(Math.min(i + batch, texts.length), texts.length);
  }
  fs.writeFileSync(INDEX_BIN, Buffer.from(matrix.buffer));
  fs.writeFileSync(INDEX_META, JSON.stringify({ count: codes.length, dim }));
  return { codes, matrix, dim };
}

export async function loadOrBuildIndex(provider, onProgress) {
  const codes = loadCodes();
  if (fs.existsSync(INDEX_BIN) && fs.existsSync(INDEX_META)) {
    const meta = JSON.parse(fs.readFileSync(INDEX_META, "utf8"));
    if (meta.count === codes.length) {
      const buf = fs.readFileSync(INDEX_BIN);
      const matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      return { codes, matrix, dim: meta.dim };
    }
  }
  return buildIndex(provider, onProgress);
}

// Prefer the .9 / "unspecified" code within the best-matching category for a generic query.
export function preferUnspecified(query, ranked) {
  if (!ranked.length || /\bwith\b|due to/i.test(query)) return ranked;
  const topCat = ranked[0].code.split(".")[0];
  const same = ranked.filter((r) => r.code.split(".")[0] === topCat);
  const generic = same.find(
    (r) => r.code.endsWith(".9") || GENERIC.some((g) => r.description.toLowerCase().includes(g)),
  );
  return generic ? [generic, ...ranked.filter((r) => r !== generic)] : ranked;
}

// Map a condition phrase -> verified ICD-10 code(s).
export async function verifyIcd(condition, provider, index, k = 3) {
  const [vec] = await provider.embed([QUERY_PREFIX + condition]);
  const q = normalize(vec);
  const { codes, matrix, dim } = index;
  const scored = new Array(codes.length);
  for (let i = 0; i < codes.length; i++) {
    let dot = 0;
    const base = i * dim;
    for (let j = 0; j < dim; j++) dot += matrix[base + j] * q[j];
    scored[i] = { code: codes[i].code, description: codes[i].description, score: dot };
  }
  scored.sort((a, b) => b.score - a.score);
  return preferUnspecified(condition, scored.slice(0, 12)).slice(0, k);
}
