#!/usr/bin/env python3
"""Model-vs-model duel on LM Studio. Two modes (selected by the system prompt + scenarios):

  INTERVIEW (default): medpsy is the PHARMACIST and must ASK targeted triage questions;
    the patient model answers a HIDDEN scenario, revealing detail only when asked. Grades
    medpsy's questioning + final triage.  (prompts/system_interview.txt + interview_scenarios.json)

  ADVERSARIAL: the patient model role-plays an adversarial caller (persona + hidden situation
    + unsafe goal); medpsy is the CDS tool that must hold the line.  (prompts/system_v4.txt +
    scenarios.json)

Either way: 'tool' = medpsy, 'patient' = the other model. Two mirrored message arrays are kept
(each model sees the other's turns as 'user'). Full transcripts saved for grading — this probes
DYNAMIC behaviour the one-shot bank misses (re-triaging when a red flag emerges, holding a boundary
across turns, asking the discriminating question).

Usage:
  uv run duel.py                                   # DEFAULT: medpsy(pharmacist) interviews qwen3.6(patient)
  uv run duel.py --patient-model medgemma-4b-it    # different patient model
  uv run duel.py --tool-model medpsy-1.7b          # smaller medpsy as the pharmacist
  # adversarial mode instead:
  uv run duel.py --tool-system-file prompts/system_v4.txt --scenarios questions_duel/scenarios.json
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import time
from pathlib import Path

import httpx

# terminal colours + status dots for the scorecard
_ANSI = {"RED": "\033[91m", "AMBER": "\033[93m", "GREEN": "\033[92m", "": ""}
_DOT = {"RED": "\U0001f534", "AMBER": "\U0001f7e1", "GREEN": "\U0001f7e2", "": "⚪"}
_RESET = "\033[0m"
_DECISION_COLOR = {"EMERGENCY": "RED", "URGENT": "AMBER", "PHARMACIST-LED": "GREEN", "ROUTINE": "GREEN"}

ROOT = Path(__file__).resolve().parent
RESULTS_DIR = ROOT / "duels"


def chat(client, base_url, model, messages, temperature, max_tokens):
    payload = {"model": model, "messages": messages, "temperature": temperature,
               "max_tokens": max_tokens, "stream": False}
    t0 = time.monotonic()
    resp = client.post(f"{base_url}/v1/chat/completions", json=payload)
    elapsed = time.monotonic() - t0
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"].strip(), round(elapsed, 2)


def _clean_patient(text):
    """Reasoning models (e.g. qwen) sometimes run away and append fabricated
    'user'/'assistant' turns, or return empty content. Cut at the first bare role
    marker and fall back to a neutral line so the next API call never sends empty."""
    lines = text.split("\n")
    out = []
    for ln in lines:
        if ln.strip().lower().rstrip(":") in ("user", "assistant", "system"):
            break
        out.append(ln)
    cleaned = "\n".join(out).strip()
    return cleaned or "Sorry, I'm not sure — what do you think I should do?"


def _verify_icd(condition):
    """Map the condition medpsy named -> a VERIFIED ICD-10 code via icd_lookup (the
    fix for medpsy's hallucinated codes). Returns (code, description). Graceful if the
    ICD deps/cache aren't available."""
    if not condition:
        return "", ""
    try:
        from icd_lookup import best_code, describe
        code = best_code(condition)
        return code, describe(code)
    except Exception:
        return "", ""


def _parse_triage(rec):
    """Pull DECISION / SEVERITY / colour from the final tool (medpsy) turn, and replace
    medpsy's (often wrong) ICD-10 code with a verified lookup from the condition it named."""
    tool_turns = [t for t in rec.get("transcript", []) if t.get("role") == "tool"]
    txt = tool_turns[-1]["content"] if tool_turns else ""
    dec_m = re.search(r"(?:DECISION|TRIAGE):\s*\**\s*([A-Za-z\-]+)", txt)
    decision = dec_m.group(1).strip().upper() if dec_m else ""
    sev_line = re.search(r"SEVERITY:\s*([^\n]+)", txt)
    sev_line = sev_line.group(1) if sev_line else ""
    sev_num = re.search(r"\d{1,2}", sev_line)
    severity = sev_num.group(0) if sev_num else ""
    col_m = re.search(r"\b(RED|AMBER|GREEN)\b", sev_line)
    color = col_m.group(1) if col_m else _DECISION_COLOR.get(decision, "")
    # medpsy's own ICD line: separate the code it gave from the condition it named
    icd_m = re.search(r"ICD[-\s]?10:\s*\**\s*(.+)", txt)
    icd_line = icd_m.group(1).strip().rstrip("*").strip() if icd_m else ""
    code_m = re.search(r"([A-TV-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?)", icd_line)
    icd_model = code_m.group(1) if code_m else ""
    condition = icd_line.replace(icd_model, "", 1) if icd_model else icd_line
    condition = re.sub(r"\(?\bsuspected\b\)?", "", condition, flags=re.I).strip(" .,;:-")
    if not condition:  # fall back to the ASSESSMENT line
        am = re.search(r"ASSESSMENT:\s*([^\n]+)", txt)
        condition = am.group(1).strip()[:80] if am else ""
    icd_verified, icd_desc = _verify_icd(condition)
    mismatch = bool(icd_model and icd_verified and
                    icd_model.upper().replace(".", "") != icd_verified.upper().replace(".", ""))
    return {"decision": decision, "severity": severity, "color": color,
            "condition": condition[:48], "icd_model": icd_model,
            "icd_verified": icd_verified, "icd_desc": icd_desc, "icd_mismatch": mismatch}


def _scorecard(records, out_dir):
    """Print a colour-coded numeric scorecard and write summary.{md,json}."""
    rows = []
    for r in records:
        if "error" in r:
            rows.append({"id": r.get("id"), "title": r.get("title"), "decision": "ERROR",
                         "severity": "", "color": "", "icd_verified": "", "icd_model": "",
                         "icd_mismatch": False, "condition": r["error"][:48]})
        else:
            rows.append({"id": r.get("id"), "title": r.get("title"), **_parse_triage(r)})

    def icd_cell(row):
        v, m = row.get("icd_verified", ""), row.get("icd_model", "")
        if not v:
            return m or "—"
        return f"{v} (medpsy:{m})" if row.get("icd_mismatch") else v

    print(f"\n{'═' * 78}\n  SCORECARD  (tool = {records[0].get('tool_model','?') if records else '?'})\n{'═' * 78}", flush=True)
    print(f"  {'':2} {'ID':5} {'SEV':3} {'DECISION':14} {'ICD-10 (verified)':26} TITLE", flush=True)
    counts = {"RED": 0, "AMBER": 0, "GREEN": 0, "": 0}
    fixed = 0
    for row in rows:
        c = row["color"]
        counts[c] = counts.get(c, 0) + 1
        fixed += bool(row.get("icd_mismatch"))
        tint = _ANSI.get(c, "")
        line = (f"  {_DOT.get(c,'⚪')}  {row['id'] or '?':5} {row['severity'] or '-':>3} "
                f"{tint}{row['decision']:14}{_RESET} {icd_cell(row)[:26]:26} {row['title'] or ''}")
        print(line, flush=True)
    print(f"\n  totals: {_DOT['RED']} {counts.get('RED',0)} RED   "
          f"{_DOT['AMBER']} {counts.get('AMBER',0)} AMBER   "
          f"{_DOT['GREEN']} {counts.get('GREEN',0)} GREEN"
          f"   |  ICD lookup corrected medpsy on {fixed} case(s)", flush=True)

    (out_dir / "summary.json").write_text(json.dumps(rows, indent=2, ensure_ascii=False))
    md = ["# Duel scorecard\n",
          "ICD-10 column = verified code from `icd_lookup` (medpsy's own code shown when it differed).\n",
          "| | ID | Severity | Decision | ICD-10 (verified) | medpsy ICD | Scenario |",
          "|--|----|----------|----------|-------------------|------------|----------|"]
    for row in rows:
        md.append(f"| {_DOT.get(row['color'],'⚪')} | {row['id']} | {row['severity'] or '—'} | "
                  f"{row['decision'] or '—'} | {row.get('icd_verified') or '—'} | "
                  f"{row.get('icd_model') or '—'}{' ⚠' if row.get('icd_mismatch') else ''} | {row['title'] or ''} |")
    (out_dir / "summary.md").write_text("\n".join(md) + "\n")


def _say(label, model, content, latency):
    """Print one turn as a readable block, flushed so it streams live."""
    rule = "─" * 78
    meta = f"({model}, {latency}s)" if latency else f"({model})"
    print(f"\n{rule}\n{label}  {meta}\n{rule}", flush=True)
    print(content.strip(), flush=True)


def run_scenario(client, args, sc, tool_system):
    turns = sc.get("turns", args.turns)
    tool_msgs = [{"role": "system", "content": tool_system}]
    # The patient history must alternate user/assistant after the system message —
    # some chat templates (e.g. Gemma) reject an assistant turn straight after system.
    # Seed a 'user' kickoff so each patient utterance is a valid 'assistant' turn and
    # each tool reply is a valid 'user' turn.
    pat_msgs = [{"role": "system", "content": sc["patient_system"]},
                {"role": "user", "content":
                 "Begin the call. Give only your opening message as the patient (first person, 1-3 sentences)."}]
    transcript = []

    for i in range(turns):
        # --- patient speaks ---
        if i == 0 and sc.get("opening"):
            patient_utt, plat = sc["opening"], 0.0
        else:
            patient_utt, plat = chat(client, args.base_url, args.patient_model, pat_msgs,
                                     args.patient_temp, args.patient_max_tokens)
            patient_utt = _clean_patient(patient_utt)
        pat_msgs.append({"role": "assistant", "content": patient_utt})
        tool_msgs.append({"role": "user", "content": patient_utt})
        transcript.append({"turn": i + 1, "role": "patient", "model": args.patient_model,
                           "content": patient_utt, "latency_s": plat})
        _say(f"\U0001f9d1 PATIENT  (turn {i + 1}/{turns})", args.patient_model, patient_utt, plat)

        # --- tool responds ---
        tool_utt, tlat = chat(client, args.base_url, args.tool_model, tool_msgs,
                              args.tool_temp, args.tool_max_tokens)
        tool_msgs.append({"role": "assistant", "content": tool_utt})
        pat_msgs.append({"role": "user", "content": tool_utt})
        transcript.append({"turn": i + 1, "role": "tool", "model": args.tool_model,
                           "content": tool_utt, "latency_s": tlat})
        _say(f"\U0001f48a TOOL     (turn {i + 1}/{turns})", args.tool_model, tool_utt, tlat)

    return transcript


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", default="http://localhost:1234")
    # Defaults = the interview duel (medpsy triages a patient played by qwen3.6).
    # For the adversarial duel instead, pass:
    #   --tool-system-file prompts/system_v4.txt --scenarios questions_duel/scenarios.json
    p.add_argument("--tool-model", default="medpsy-4b", help="The medpsy model (interviewing pharmacist)")
    p.add_argument("--tool-system-file", default="prompts/system_interview.txt")
    p.add_argument("--patient-model", default="qwen3.6-27b-optiq", help="Model playing the patient")
    p.add_argument("--scenarios", default="questions_duel/interview_scenarios.json")
    p.add_argument("--turns", type=int, default=5, help="Default turns if a scenario omits it")
    p.add_argument("--tool-temp", type=float, default=0.3)
    p.add_argument("--patient-temp", type=float, default=0.7)
    p.add_argument("--tool-max-tokens", type=int, default=1024)
    p.add_argument("--patient-max-tokens", type=int, default=1600,
                   help="Keep high (~1600): reasoning patient models spend tokens thinking before replying")
    p.add_argument("--label", help="Tag for the output dir name")
    p.add_argument("--timeout", type=float, default=600.0)
    args = p.parse_args()

    tool_system = Path(args.tool_system_file).read_text().strip()
    doc = json.loads(Path(args.scenarios).read_text())
    scenarios = doc.get("scenarios", [])

    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    if args.label:
        stamp = f"{stamp}-{args.label}"
    out_dir = RESULTS_DIR / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Tool (under test): {args.tool_model}  [sys={Path(args.tool_system_file).name}]")
    print(f"Patient (adversary): {args.patient_model}")
    print(f"Output: {out_dir}\n")

    meta = {"timestamp": stamp, "tool_model": args.tool_model,
            "tool_system_file": args.tool_system_file, "patient_model": args.patient_model,
            "tool_temp": args.tool_temp, "patient_temp": args.patient_temp}
    (out_dir / "run_meta.json").write_text(json.dumps(meta, indent=2))

    records = []
    with httpx.Client(timeout=args.timeout) as client:
        for n, sc in enumerate(scenarios, 1):
            sid = sc.get("id", "?")
            print(f"\n{'═' * 78}\n  SCENARIO {n}/{len(scenarios)} — [{sid}] {sc.get('title','')}"
                  f"  ({sc.get('turns', args.turns)} turns)\n{'═' * 78}", flush=True)
            if sc.get("expected"):
                print(f"  grading note: {sc['expected']}", flush=True)
            try:
                transcript = run_scenario(client, args, sc, tool_system)
                record = {"id": sid, "title": sc.get("title"), "subcategory": sc.get("subcategory"),
                          "expected": sc.get("expected"), "tool_model": args.tool_model,
                          "patient_model": args.patient_model, "transcript": transcript}
            except Exception as e:  # noqa: BLE001
                record = {"id": sid, "title": sc.get("title"), "error": f"{type(e).__name__}: {e}"}
                print(f"\n  ERROR: {record['error']}", flush=True)
            (out_dir / f"{sid}.json").write_text(json.dumps(record, indent=2, ensure_ascii=False))
            records.append(record)

    _scorecard(records, out_dir)
    print(f"\nDone. Transcripts + summary saved in {out_dir}", flush=True)


if __name__ == "__main__":
    main()
