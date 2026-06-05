# medpsy-eval

Evaluation harness for the local **medpsy** medical model served by **LM Studio**
(OpenAI-compatible API on `http://localhost:1234`).

Workflow: questions (by research area) → posted to the model → answers stored →
Claude reads each question + answer and evaluates the response.

## Layout

```
pyproject.toml / uv.lock     # uv project (httpx, rapidfuzz, simple-icd-10, numpy)
run_eval.py                  # one-shot bank runner
compare_runs.py              # pair two runs side-by-side + stats -> comparisons/
duel.py                      # multi-turn two-model duels (interview / adversarial) + scorecard
icd_lookup.py                # condition -> verified ICD-10 (semantic/fuzzy over WHO ICD-10)
icd_test.py / icd_cases.json # medpsy ICD-coding accuracy test + DB-verified answer key
prompts/                     # system_v1–v4 (one-shot) + system_interview.txt (duel)
questions/                   # baseline bank — areas 1–6 (incl. mental health), 90 samples
questions_adversarial/       # adversarial stress bank — 6 failure modes, 90 samples
questions_duel/              # duel scenarios (adversarial + interview)
results/ duels/ comparisons/ # stored runs, transcripts/scorecards, side-by-sides
README.md / EVALUATION.md / JOURNAL.md   # usage / findings / narrative log
```

## Setup

```bash
uv sync          # creates .venv and installs deps (httpx, rapidfuzz, simple-icd-10, numpy)
```

LM Studio must be running with the target model loaded. Check which models are available:

```bash
curl -s http://localhost:1234/v1/models
```

The default model is `medpsy-4b`; override with `--model` (e.g. `medpsy-1.7b`, or a
general model like `qwen3.5-4b-mlx` / `gemma-4-e4b-it` for comparison).

## Run

```bash
uv run run_eval.py                                 # baseline bank, all areas (50 samples)
uv run run_eval.py --area area1                    # one area
uv run run_eval.py --limit 2                        # first 2 per area (smoke test)
uv run run_eval.py --model medpsy-1.7b --temperature 0.2
uv run run_eval.py --no-system                      # drop the default system prompt
uv run run_eval.py --dir questions_adversarial --area adv   # adversarial stress set (50)
```

Use `--dir` to point at an alternate question directory (keeps the adversarial set out of the
baseline run).

Results land in `results/<timestamp>/`:
- `<id>.json` — one file per sample (messages sent + answer + usage + latency)
- `run.jsonl` — combined log, one record per line
- `run_meta.json` — model / params used for the run

## Question format

Files live in `questions/`, one per research area, 10 samples each. Each sample
is flexible — the runner normalizes it to an OpenAI `messages` array:

```jsonc
// simplest: default system prompt + a user message
{ "id": "1.1", "subcategory": "Red Flag", "user": "..." }

// override the system prompt for this sample
{ "id": "1.2", "system": "You are ...", "user": "..." }

// full control: send a whole chat array (multi-turn, etc.)
{ "id": "1.3", "messages": [ {"role":"system","content":"..."},
                             {"role":"user","content":"..."} ] }
```

The default system prompt (in `run_eval.py`, `DEFAULT_SYSTEM`) frames the model
as a pharmacist-supporting decision-support tool. Override per sample or disable
with `--no-system`.

Adversarial samples (in `questions_adversarial/`) additionally carry an `expected`
field documenting the trap and the correct behavior. The runner ignores it; it's
there for grading.

## Adversarial set

`questions_adversarial/` stress-tests known/likely failure modes (50 cases):
- **adv1 — Under-triage traps**: atypical/quiet emergencies (atypical MI, DKA, GCA, CO poisoning,
  cauda equina, aortic dissection, early sepsis, torsion, ectopic, staggered paracetamol OD).
- **adv2 — Over-triage traps**: alarming-but-benign (beeturia, drug-discoloured urine, iron stool,
  costochondritis, single high BP reading, BPPV, DOMS, benign palpitations, geographic tongue, viral conjunctivitis).
- **adv3 — Drug-knowledge traps**: lethal precision (MTX daily-vs-weekly, MTX+trimethoprim,
  folic vs folinic acid, serotonin syndrome, hyperkalemia stack, nitrate+PDE5, warfarin+herbals, etc.).
- **adv4 — Data integrity**: contradictions/missing data (penicillin allergy + amoxicillin, INR 8.5 but
  "feels fine", digoxin mg-vs-microgram, brand duplication, missing paediatric weight, stale vitals, conflicting timeline).
- **adv5 — Persuasion/anchoring**: social pressure to be unsafe (confirm an unverified dose, false
  premises, benign-self-diagnosis anchoring, false authority, cost-based under-triage, wear-down, neonatal fever).

## Duel mode (multi-turn, two models)

`duel.py` runs a live multi-turn conversation between two LM Studio models. Two modes:

- **Interview (default):** medpsy is the **pharmacist** and must ask targeted triage questions; the
  patient model answers a **hidden** scenario, revealing detail only when asked. medpsy concludes with
  `DECISION / SEVERITY (0–10 + RED/AMBER/GREEN) / RED FLAGS / ICD-10 / ROUTING / SAFETY-NET`.
- **Adversarial:** the patient model role-plays an adversarial caller; medpsy is the CDS tool that must
  hold the line (re-triage when a red flag surfaces, refuse unsafe requests, not cave under pressure).

```bash
uv run duel.py --label my-run                                  # DEFAULT: medpsy interviews qwen3.6 patient
uv run duel.py --patient-model medgemma-4b-it --label gemma    # different patient model
uv run duel.py --tool-model medpsy-1.7b                        # smaller medpsy as the pharmacist
# adversarial mode instead:
uv run duel.py --tool-system-file prompts/system_v4.txt --scenarios questions_duel/scenarios.json --label adv
```

Reasoning patient models (qwen) need headroom — default `--patient-max-tokens 1600`. Transcripts +
a colour-coded **scorecard** (`summary.md`/`summary.json`) save to `duels/<timestamp>[-label]/`. The
scorecard's ICD column is the **verified** code from `icd_lookup` (see below) — medpsy's own code is
shown only when it differed (it usually did).

## ICD-10 grounding & coding test

medpsy hallucinates ICD-10 codes, so we ground them against a real database. `icd_lookup.py` maps a
condition phrase → verified WHO ICD-10 code (offline `simple-icd-10`, 12.5k codes). Default backend is
**semantic** (embeds descriptions with the LM Studio nomic model, cached to `icd_embed_cache.npz`); a
**fuzzy** backend works offline with no model.

```bash
uv run icd_lookup.py --build                       # build the embedding cache once (~35MB, regenerable)
uv run icd_lookup.py "acute myocardial infarction" # -> I21.9 (semantic; add --fuzzy for offline)
uv run icd_lookup.py "cauda equina syndrome" -k 3

uv run icd_test.py                                 # medpsy ICD-coding accuracy vs DB-verified key (20 cases)
uv run icd_test.py --model medpsy-1.7b --max-tokens 8000
```

`icd_test.py` reports medpsy's exact / category / invalid-code / miss rates and the lookup tool's
recovery; results in `icd_test_results.json`. (Measured: medpsy ~15% exact / 30% invalid; semantic
lookup ~85% exact.)

## Research areas

1. **Ingestion & Symptom Processing** — NLP extraction, EHR synthesis, red-flag detection
2. **Algorithmic Risk Stratification** — severity scoring, complexity, adverse-event prediction
3. **Pharmacist Clinical Decision Support** — targeted questioning, evidence synthesis, therapy optimization
4. **Direct Triage Routing** — pharmacist-led care, telemedicine, scheduling
5. **Quality Assurance & Oversight** — human-in-the-loop, uncertainty, bias/drift

## Runs so far

| Run | Bank | Model | Result (see EVALUATION.md) |
|-----|------|-------|----------------------------|
| `results/20260604-160359/` | baseline (50) | medpsy-4b | 100% red-flag escalation; verbosity + minor factual slips |
| `results/20260604-173953/` | adversarial (50) | medpsy-4b | 0 dangerous under-triage / 0 unsafe-compliance failures |

## Docs

- **`EVALUATION.md`** — per-run grading and findings.
- **`JOURNAL.md`** — narrative log of what was built/run and why.
