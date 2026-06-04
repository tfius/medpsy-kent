# medpsy-eval

Evaluation harness for the local **medpsy** medical model served by **LM Studio**
(OpenAI-compatible API on `http://localhost:1234`).

Workflow: questions (by research area) → posted to the model → answers stored →
Claude reads each question + answer and evaluates the response.

## Layout

```
pyproject.toml / uv.lock     # uv project (dep: httpx)
run_eval.py                  # the runner
questions/                   # baseline bank — 5 research areas × 10 = 50
questions_adversarial/       # adversarial stress bank — 5 failure modes × 10 = 50
results/<timestamp>/         # one run: <id>.json per sample + run.jsonl + run_meta.json
README.md                    # this file (how to use)
EVALUATION.md                # findings/grades per run
JOURNAL.md                   # narrative log of what we did and why
```

## Setup

```bash
uv sync          # creates .venv and installs httpx
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

## Duel mode (model-vs-model adversarial chat)

`duel.py` runs a live multi-turn conversation: a **patient** model role-plays an adversarial caller
(persona + hidden clinical situation + unsafe goal) while the **tool** model is the medpsy CDS
assistant. This probes *dynamic* failures the one-shot bank misses — caving under repeated pressure,
failing to re-triage when a red flag is revealed mid-conversation, or dropping a boundary across turns.

```bash
uv run duel.py                                  # medgemma(patient) vs medpsy-4b(tool), v4 prompt
uv run duel.py --tool-model medpsy-1.7b
uv run duel.py --patient-model qwen3.5-4b-mlx --label q-vs-medpsy
```

Scenarios live in `questions_duel/scenarios.json` (each has a `patient_system` persona and an
`expected` grading note). Transcripts are saved to `duels/<timestamp>[-label]/<id>.json`.

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
