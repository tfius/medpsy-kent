#!/usr/bin/env python3
"""Offline ICD-10 lookup (WHO 2019, simple_icd_10 dataset, 12.5k codes).

medpsy hallucinates plausible-but-wrong ICD-10 codes. The fix: take the CONDITION
named and look up the verified code here. Two backends:
  - SEMANTIC (default if the local embedding model is up): embeds all descriptions
    with the nomic model in LM Studio (cached to icd_embed_cache.npz) and ranks by
    cosine similarity — robust to wording ("anaphylactic shock" -> T78.2, not the
    fuzzy mismatch R45.7 "emotional shock").
  - FUZZY (rapidfuzz WRatio): offline fallback, no model needed.
Both then apply an "unspecified" re-rank: for a generically-named condition, prefer
the .9 / unspecified code within the best-matching 3-char category.

Usage:
  uv run icd_lookup.py "acute myocardial infarction"      # auto (semantic if available)
  uv run icd_lookup.py --build                              # build/refresh the embedding cache
  uv run icd_lookup.py "pneumonia" --fuzzy -k 3
"""
from __future__ import annotations

import sys
from pathlib import Path

import httpx
import simple_icd_10 as icd
from rapidfuzz import fuzz, process
# numpy is imported lazily inside the semantic/embedding functions so the fuzzy
# path (and the rest of the harness) works even if numpy isn't installed.

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "icd_embed_cache.npz"
EMBED_URL = "http://localhost:1234/v1/embeddings"
EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5"

_ITEMS = [c for c in icd.get_all_codes(with_dots=True) if icd.is_category_or_subcategory(c)]
_DESCS = [icd.get_description(c) for c in _ITEMS]
_DESC_BY_CODE = dict(zip(_ITEMS, _DESCS))
_GENERIC = ("unspecified", "not specified", ", nos", "site not specified")
_emb_matrix = None  # lazily loaded


# ---- code helpers ---------------------------------------------------------
def norm(code: str) -> str:
    if not code:
        return ""
    code = code.strip().upper().replace(" ", "")
    try:
        return icd.add_dot(icd.remove_dot(code))
    except Exception:
        return code


def is_valid(code: str) -> bool:
    return icd.is_valid_item(norm(code))


def describe(code: str) -> str:
    c = norm(code)
    return _DESC_BY_CODE.get(c) or (icd.get_description(c) if icd.is_valid_item(c) else "")


def _category(code: str) -> str:
    return norm(code).split(".")[0]


# ---- embeddings -----------------------------------------------------------
def _embed(texts, batch=256):
    import numpy as np
    out = []
    with httpx.Client(timeout=120) as client:
        for i in range(0, len(texts), batch):
            chunk = texts[i:i + batch]
            r = client.post(EMBED_URL, json={"model": EMBED_MODEL, "input": chunk})
            r.raise_for_status()
            out.extend(d["embedding"] for d in r.json()["data"])
    arr = np.asarray(out, dtype=np.float32)
    arr /= (np.linalg.norm(arr, axis=1, keepdims=True) + 1e-9)
    return arr


def build_cache():
    import numpy as np
    print(f"Embedding {len(_DESCS)} ICD-10 descriptions with {EMBED_MODEL} ...", flush=True)
    mat = _embed([f"search_document: {d}" for d in _DESCS])
    np.savez_compressed(CACHE, codes=np.array(_ITEMS), emb=mat)
    print(f"wrote {CACHE} ({mat.shape})", flush=True)
    return mat


def _load_matrix():
    import numpy as np
    global _emb_matrix
    if _emb_matrix is not None:
        return _emb_matrix
    if CACHE.exists():
        data = np.load(CACHE, allow_pickle=True)
        if list(data["codes"]) == _ITEMS:
            _emb_matrix = data["emb"]
            return _emb_matrix
    return None


def _semantic(query, k):
    import numpy as np
    mat = _load_matrix()
    if mat is None:
        return None
    qv = _embed([f"search_query: {query}"])[0]
    sims = mat @ qv
    idx = np.argsort(-sims)[:k]
    return [(_ITEMS[i], _DESCS[i], int(round(float(sims[i]) * 100))) for i in idx]


def _fuzzy(query, k):
    hits = process.extract(query, _DESCS, scorer=fuzz.WRatio, limit=k)
    return [(_ITEMS[i], d, int(s)) for d, s, i in hits]


def _prefer_unspecified(query, cands):
    """For a generically-named condition, promote the .9/unspecified code within the
    best-matching 3-char category (e.g. I26 -> I26.9)."""
    if not cands:
        return cands
    top_cat = _category(cands[0][0])
    ql = query.lower()
    # if the query itself names a specific subtype, don't override
    if any(w in ql for w in ("with ", "due to", "transmural", "subendocardial")):
        return cands
    same = [c for c in cands if _category(c[0]) == top_cat]
    for c in same:
        if norm(c[0]).endswith(".9") or any(g in c[1].lower() for g in _GENERIC):
            return [c] + [x for x in cands if x is not c]
    return cands


# ---- public API -----------------------------------------------------------
def lookup(query: str, k: int = 5, method: str = "auto"):
    if method == "fuzzy":
        cands = _fuzzy(query, max(k, 12))
    else:
        cands = _semantic(query, max(k, 12))
        if cands is None:  # no embedding cache/endpoint -> fall back
            cands = _fuzzy(query, max(k, 12))
    return _prefer_unspecified(query, cands)[:k]


def best_code(query: str, method: str = "auto") -> str:
    res = lookup(query, 1, method)
    return res[0][0] if res else ""


def main() -> None:
    args = sys.argv[1:]
    if "--build" in args:
        build_cache()
        return
    method = "fuzzy" if "--fuzzy" in args else "auto"
    args = [a for a in args if a != "--fuzzy"]
    k = 5
    if "-k" in args:
        i = args.index("-k")
        k = int(args[i + 1])
        del args[i:i + 2]
    query = " ".join(args)
    if not query:
        sys.exit("usage: uv run icd_lookup.py \"<phrase>\" [-k N] [--fuzzy] | --build")
    print(f"query: {query!r}  (method={method})\n")
    for code, desc, score in lookup(query, k, method):
        print(f"  {code:8} {score:3}  {desc}")


if __name__ == "__main__":
    main()
