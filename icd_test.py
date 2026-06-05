#!/usr/bin/env python3
"""Measure how often medpsy assigns the WRONG ICD-10 code.

For each curated vignette: ask medpsy for the single best ICD-10 code, compare to
the DB-verified expected_code, and (for contrast) show what the deterministic
icd_lookup tool returns from the named condition. Reports exact / category-level /
invalid-code / miss rates — i.e. how much the model misses, and how much the lookup
tool recovers.

Usage:
  uv run icd_test.py                 # medpsy-4b
  uv run icd_test.py --model medpsy-1.7b
"""
from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import httpx

from icd_lookup import describe, is_valid, lookup, norm

ROOT = Path(__file__).resolve().parent
CODE_RE = re.compile(r"\b([A-TV-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?)\b")

PROMPT = (
    "You are a clinical coder. Give the SINGLE most appropriate WHO ICD-10 code for the "
    "presentation below. Reply on one line EXACTLY as:\n"
    "CODE: <code> | TITLE: <official ICD-10 title>\n\nPresentation: {v}"
)


def category(code: str) -> str:
    return norm(code).split(".")[0]


def ask_medpsy(client, base_url, model, vignette, max_tokens):
    payload = {"model": model, "messages": [{"role": "user", "content": PROMPT.format(v=vignette)}],
               "temperature": 0.1, "max_tokens": max_tokens, "stream": False}
    r = client.post(f"{base_url}/v1/chat/completions", json=payload)
    r.raise_for_status()
    txt = r.json()["choices"][0]["message"]["content"]
    code_m = re.search(r"CODE:\s*\**\s*([A-TV-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?)", txt)
    code = code_m.group(1) if code_m else (CODE_RE.search(txt).group(1) if CODE_RE.search(txt) else "")
    title_m = re.search(r"TITLE:\s*\**\s*(.+)", txt)
    title = title_m.group(1).strip().rstrip("*").strip()[:60] if title_m else ""
    return code, title, txt


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", default="http://localhost:1234")
    p.add_argument("--model", default="medpsy-4b")
    p.add_argument("--cases", default="icd_cases.json")
    p.add_argument("--max-tokens", type=int, default=8000,
                   help="High ceiling so a reasoning model finishes thinking before answering")
    p.add_argument("--timeout", type=float, default=300.0)
    args = p.parse_args()

    cases = json.loads(Path(args.cases).read_text())["cases"]
    rows = []
    print(f"Model: {args.model}\n")
    hdr = f"{'ID':4} {'EXPECTED':19} {'MEDPSY':19} {'OK':3} {'TOOL(lookup)':19} {'CONDITION'}"
    print(hdr); print("-" * len(hdr))

    with httpx.Client(timeout=args.timeout) as client:
        for c in cases:
            exp = c["expected_code"]
            code, title, _ = ask_medpsy(client, args.base_url, args.model, c["vignette"], args.max_tokens)
            exact = norm(code) == norm(exp)
            cat = bool(code) and category(code) == category(exp)
            valid = is_valid(code)
            tool_code = lookup(c["condition"], 1)[0][0] if c["condition"] else ""
            tool_exact = norm(tool_code) == norm(exp)
            tool_cat = category(tool_code) == category(exp)
            mark = "✓" if exact else ("~" if cat else ("?" if not valid else "✗"))
            rows.append({"id": c["id"], "condition": c["condition"], "expected": exp,
                         "expected_desc": describe(exp), "medpsy_code": code, "medpsy_title": title,
                         "medpsy_valid": valid, "exact": exact, "category": cat,
                         "tool_code": tool_code, "tool_exact": tool_exact, "tool_category": tool_cat})
            exp_s = f"{exp} {describe(exp)[:11]}"
            med_s = f"{code or '—'} {describe(code)[:11] if valid else ('INVALID' if code else '')}"
            tool_s = f"{tool_code} {describe(tool_code)[:11]}"
            print(f"{c['id']:4} {exp_s:19.19} {med_s:19.19} {mark:3} {tool_s:19.19} {c['condition']}")

    n = len(rows)
    def pct(x): return f"{100*x/n:.0f}%"
    ex = sum(r["exact"] for r in rows)
    catn = sum(r["category"] for r in rows)
    inval = sum(not r["medpsy_valid"] for r in rows)
    tool_ex = sum(r["tool_exact"] for r in rows)
    tool_cat = sum(r["tool_category"] for r in rows)
    print("\n" + "=" * 60)
    print(f"medpsy ICD-10 coding ({args.model}), n={n}:")
    print(f"  exact code match     : {ex}/{n}  ({pct(ex)})")
    print(f"  category (3-char) hit : {catn}/{n}  ({pct(catn)})")
    print(f"  invalid/hallucinated  : {inval}/{n}  ({pct(inval)})")
    print(f"  MISS (not exact)      : {n-ex}/{n}  ({pct(n-ex)})")
    print(f"\nlookup tool (deterministic) from the named condition:")
    print(f"  exact                 : {tool_ex}/{n}  ({pct(tool_ex)})")
    print(f"  category              : {tool_cat}/{n}  ({pct(tool_cat)})")

    out = ROOT / "icd_test_results.json"
    out.write_text(json.dumps({"model": args.model, "n": n,
                               "summary": {"exact": ex, "category": catn, "invalid": inval,
                                           "tool_exact": tool_ex, "tool_category": tool_cat},
                               "rows": rows}, indent=2, ensure_ascii=False))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
