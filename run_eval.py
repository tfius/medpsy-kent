#!/usr/bin/env python3
"""Run the medpsy question bank against an LM Studio (OpenAI-compatible) endpoint.

Each question "sample" is flexible:
  - {"system": "...", "user": "..."}   -> built into a 2-message chat
  - {"user": "..."}                     -> uses the default system prompt
  - {"messages": [ ... ]}               -> sent verbatim (full chat array)

Results are written one JSON file per sample plus a combined run.jsonl, so the
question + answer can be read back and evaluated.

Usage:
  uv run run_eval.py                       # run every area in questions/
  uv run run_eval.py --area area1          # run one file (matches questions/area1*.json)
  uv run run_eval.py --file questions/x.json
  uv run run_eval.py --limit 2             # only first 2 samples per file (quick smoke test)
  uv run run_eval.py --no-system           # drop the default system prompt
  uv run run_eval.py --model medpsy-1.7b --temperature 0.2
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent
QUESTIONS_DIR = ROOT / "questions"
RESULTS_DIR = ROOT / "results"

# Default clinical-decision-support framing. Override per-sample with a "system"
# field, send a full "messages" array, or disable with --no-system.
DEFAULT_SYSTEM = (
    "You are a clinical decision-support assistant for a community pharmacy. "
    "You support a registered pharmacist; you are NOT a standalone diagnostician and "
    "the pharmacist makes the final decision. Flag any life-threatening (red-flag) "
    "symptoms for immediate escalation to emergency care. Be concise, evidence-based, "
    "and state your uncertainty when information is incomplete."
)


def build_messages(sample: dict, default_system: str | None) -> list[dict]:
    """Normalize a sample into an OpenAI-style messages array."""
    if sample.get("messages"):
        return sample["messages"]
    messages: list[dict] = []
    system = sample.get("system", default_system)
    if system:
        messages.append({"role": "system", "content": system})
    if sample.get("user"):
        messages.append({"role": "user", "content": sample["user"]})
    if not messages:
        raise ValueError(f"Sample {sample.get('id')!r} has no messages/user content")
    return messages


def call_model(
    client: httpx.Client,
    base_url: str,
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int,
) -> dict:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    t0 = time.monotonic()
    resp = client.post(f"{base_url}/v1/chat/completions", json=payload)
    elapsed = time.monotonic() - t0
    resp.raise_for_status()
    data = resp.json()
    return {
        "answer": data["choices"][0]["message"]["content"],
        "finish_reason": data["choices"][0].get("finish_reason"),
        "usage": data.get("usage", {}),
        "latency_s": round(elapsed, 2),
        "raw": data,
    }


def discover_files(args) -> list[Path]:
    if args.file:
        return [Path(args.file)]
    qdir = Path(args.dir) if args.dir else QUESTIONS_DIR
    if args.area:
        matches = sorted(qdir.glob(f"{args.area}*.json"))
        if not matches:
            sys.exit(f"No question file matching {args.area!r} in {qdir}")
        return matches
    return sorted(qdir.glob("*.json"))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", default="http://localhost:1234", help="LM Studio base URL")
    p.add_argument("--model", default="medpsy-4b", help="Model id as listed by /v1/models")
    p.add_argument("--area", help="Run only files matching this prefix, e.g. 'area1' or 'adv'")
    p.add_argument("--file", help="Run a single specific question file")
    p.add_argument("--dir", help="Question directory to scan (default: questions/)")
    p.add_argument("--temperature", type=float, default=0.3)
    p.add_argument("--max-tokens", type=int, default=2048)
    p.add_argument("--limit", type=int, help="Only run the first N samples per file")
    p.add_argument("--no-system", action="store_true", help="Do not inject the default system prompt")
    p.add_argument("--timeout", type=float, default=600.0, help="Per-request timeout in seconds")
    p.add_argument("--out-dir", help="Override output directory (default: results/<timestamp>)")
    args = p.parse_args()

    default_system = None if args.no_system else DEFAULT_SYSTEM
    files = discover_files(args)

    # Timestamp passed in via local clock (fine outside the workflow sandbox).
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out_dir) if args.out_dir else RESULTS_DIR / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    run_log = out_dir / "run.jsonl"

    print(f"Model:   {args.model}")
    print(f"Server:  {args.base_url}")
    print(f"Output:  {out_dir}")
    print(f"Files:   {', '.join(f.name for f in files)}\n")

    run_meta = {
        "timestamp": stamp,
        "model": args.model,
        "base_url": args.base_url,
        "temperature": args.temperature,
        "max_tokens": args.max_tokens,
        "default_system": default_system,
    }
    (out_dir / "run_meta.json").write_text(json.dumps(run_meta, indent=2))

    total = 0
    errors = 0
    with httpx.Client(timeout=args.timeout) as client, run_log.open("w") as log:
        for f in files:
            doc = json.loads(f.read_text())
            area = doc.get("area", f.stem)
            samples = doc.get("samples", [])
            if args.limit:
                samples = samples[: args.limit]
            print(f"=== {area}  ({len(samples)} samples from {f.name}) ===")
            for sample in samples:
                total += 1
                sid = sample.get("id", str(total))
                try:
                    messages = build_messages(sample, default_system)
                    result = call_model(
                        client, args.base_url, args.model, messages,
                        args.temperature, args.max_tokens,
                    )
                    record = {
                        "id": sid,
                        "area": area,
                        "subcategory": sample.get("subcategory"),
                        "source_file": f.name,
                        "messages": messages,
                        "answer": result["answer"],
                        "finish_reason": result["finish_reason"],
                        "usage": result["usage"],
                        "latency_s": result["latency_s"],
                        "model": args.model,
                    }
                    status = f"{result['latency_s']}s"
                    if result["finish_reason"] == "length":
                        status += " (truncated: hit max_tokens)"
                except Exception as e:  # noqa: BLE001 - we want to log and continue
                    errors += 1
                    record = {
                        "id": sid,
                        "area": area,
                        "subcategory": sample.get("subcategory"),
                        "source_file": f.name,
                        "error": f"{type(e).__name__}: {e}",
                    }
                    status = f"ERROR: {record['error']}"

                (out_dir / f"{sid}.json").write_text(json.dumps(record, indent=2, ensure_ascii=False))
                log.write(json.dumps(record, ensure_ascii=False) + "\n")
                log.flush()
                print(f"  [{sid}] {sample.get('subcategory', '')} -> {status}")
            print()

    print(f"Done. {total} samples, {errors} errors. Results in {out_dir}")
    print(f"Combined log: {run_log}")


if __name__ == "__main__":
    main()
