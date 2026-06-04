#!/usr/bin/env python3
"""Pair two or more eval runs by sample id into a side-by-side for grading.

Works for any comparison: model-vs-model (head-to-head) or prompt-v1-vs-v2 (A/B),
as long as the runs cover the same sample ids.

Usage:
  uv run compare_runs.py results/RUN_A results/RUN_B
  uv run compare_runs.py results/RUN_A results/RUN_B --questions-dir questions_adversarial \
      --out comparisons/medpsy-vs-medgemma.md

For each shared sample it prints the question, the `expected` trap (if a questions dir
is given), and each run's answer with its latency + token count. Ends with a per-run
stats table (avg latency, completion tokens, answer length). Pure stdlib.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from pathlib import Path


def natural_key(sid: str):
    """Sort '1.2' < '1.10' and 'A1.2' < 'A1.10' correctly."""
    prefix = "".join(c for c in sid if c.isalpha())
    nums = "".join(c if (c.isdigit() or c == ".") else " " for c in sid).split()
    return (prefix, [int(p) for p in ".".join(nums).split(".") if p.isdigit()])


def load_run(run_dir: Path) -> tuple[dict, dict]:
    """Return (records_by_id, meta)."""
    records = {}
    for f in glob.glob(str(run_dir / "*.json")):
        name = os.path.basename(f)
        if name in ("run_meta.json",):
            continue
        rec = json.loads(Path(f).read_text())
        if "id" in rec:
            records[rec["id"]] = rec
    meta = {}
    meta_path = run_dir / "run_meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
    return records, meta


def load_expected(questions_dir: Path) -> dict:
    expected = {}
    for f in glob.glob(str(questions_dir / "*.json")):
        doc = json.loads(Path(f).read_text())
        for s in doc.get("samples", []):
            if "id" in s and "expected" in s:
                expected[s["id"]] = s["expected"]
    return expected


def user_msg(rec: dict) -> str:
    for m in rec.get("messages", []):
        if m.get("role") == "user":
            return m["content"]
    return "(no user message stored)"


def label_for(meta: dict, run_dir: Path) -> str:
    model = meta.get("model", "?")
    lbl = meta.get("label")
    src = meta.get("system_source", "")
    tag = f" [{lbl}]" if lbl else ""
    sysp = f" sys={os.path.basename(src)}" if src and src not in ("DEFAULT_SYSTEM", "none") else (f" sys={src}" if src else "")
    return f"{model}{tag}{sysp}  ({run_dir.name})"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("runs", nargs="+", help="Two or more results/<run> directories")
    p.add_argument("--questions-dir", help="Pull each sample's `expected` field from here")
    p.add_argument("--out", help="Write markdown here (default: stdout)")
    args = p.parse_args()

    run_dirs = [Path(r) for r in args.runs]
    loaded = [(rd, *load_run(rd)) for rd in run_dirs]  # (dir, records, meta)
    expected = load_expected(Path(args.questions_dir)) if args.questions_dir else {}

    all_ids = sorted({sid for _, recs, _ in loaded for sid in recs}, key=natural_key)
    labels = [label_for(meta, rd) for rd, _, meta in loaded]

    out = []
    out.append(f"# Run comparison\n")
    for i, lab in enumerate(labels, 1):
        out.append(f"- **Run {i}:** {lab}")
    out.append("")

    for sid in all_ids:
        first = next((recs[sid] for _, recs, _ in loaded if sid in recs), {})
        out.append("=" * 100)
        out.append(f"## [{sid}] {first.get('area','')} — {first.get('subcategory','')}")
        out.append(f"\n**Q:** {user_msg(first)}")
        if sid in expected:
            out.append(f"\n**EXPECTED (trap):** {expected[sid]}")
        for i, (rd, recs, _) in enumerate(loaded, 1):
            rec = recs.get(sid)
            out.append(f"\n### Run {i} answer")
            if not rec:
                out.append("_(missing — not in this run)_")
                continue
            if "error" in rec:
                out.append(f"_(error: {rec['error']})_")
                continue
            u = rec.get("usage", {})
            meta_line = f"_latency {rec.get('latency_s','?')}s · completion {u.get('completion_tokens','?')} tok · {len(rec.get('answer',''))} chars · finish={rec.get('finish_reason')}_"
            out.append(meta_line)
            out.append("")
            out.append(rec.get("answer", "").strip())
        out.append("")

    # Stats table
    out.append("=" * 100)
    out.append("## Stats\n")
    out.append("| Run | Model | Answered | Avg latency (s) | Avg completion tok | Avg chars |")
    out.append("|-----|-------|----------|-----------------|--------------------|-----------|")
    for i, (rd, recs, meta) in enumerate(loaded, 1):
        ans = [r for r in recs.values() if "answer" in r]
        n = len(ans)
        if n:
            al = sum(r.get("latency_s", 0) for r in ans) / n
            at = sum(r.get("usage", {}).get("completion_tokens", 0) for r in ans) / n
            ac = sum(len(r.get("answer", "")) for r in ans) / n
        else:
            al = at = ac = 0
        out.append(f"| {i} | {meta.get('model','?')} | {n} | {al:.1f} | {at:.0f} | {ac:.0f} |")

    text = "\n".join(out)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text)
        print(f"Wrote {args.out}  ({len(all_ids)} samples, {len(loaded)} runs)")
    else:
        print(text)


if __name__ == "__main__":
    main()
