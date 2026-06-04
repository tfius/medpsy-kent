# Project journal — medpsy-eval

A running log of *what* we built/ran and *why*. Newest entries at the bottom.
Companion docs: `README.md` (how to use), `EVALUATION.md` (findings per run).

---

## 2026-06-04 — Session 1: harness, baseline bank, baseline run

### Goal
Stand up a repeatable way to evaluate a locally-hosted medical model (`medpsy`,
served by LM Studio on `:1234`, 256k context) as a **pharmacist clinical
decision-support** tool. The human workflow: post health questions → store each
conversation → Claude reads question+answer and grades it. Five research areas
drive the question design:

1. Ingestion & Symptom Processing (NLP extraction, EHR synthesis, red-flag detection)
2. Algorithmic Risk Stratification (severity scoring, complexity, adverse-event prediction)
3. Pharmacist Clinical Decision Support (targeted questioning, evidence synthesis, therapy optimization)
4. Direct Triage Routing (pharmacist-led care, telemedicine, scheduling)
5. Quality Assurance & Oversight (human-in-the-loop, uncertainty, bias/drift)

### What we built
- **uv project** (`pyproject.toml`, dep: `httpx`). Chose uv per the request and
  kept deps minimal — just an HTTP client; LM Studio is OpenAI-compatible so no SDK needed.
- **`run_eval.py`** — posts to `/v1/chat/completions`, stores results. Key design
  decisions and *why*:
  - **Flexible sample schema.** Each question can be `{system,user}`, just `{user}`
    (uses a default system prompt), or a full `{messages:[...]}` array. This was an
    explicit requirement ("prompts, questions, answers, or whole chat messages
    array") and means we can start simple now and grow into multi-turn later without
    touching the runner.
  - **Default system prompt** (`DEFAULT_SYSTEM`) frames the model as a
    pharmacist-supporting, non-diagnostic tool that escalates red flags. Overridable
    per sample or disabled with `--no-system`, so we can A/B the framing.
  - **One JSON file per sample + a combined `run.jsonl` + `run_meta.json`.** Per-file
    is easy for a human/Claude to open one case; jsonl is easy to process in bulk;
    meta records model/params so runs are self-describing and comparable.
  - **`stream:false`, 600s timeout, temp 0.3, max_tokens 2048.** Low temp for clinical
    consistency; long timeout because a 256k-context model can generate slowly.
  - Errors are caught per-sample and logged (the run never aborts mid-bank).
- **Question bank** (`questions/`, 5 files × 10 = 50). Hand-written clinical
  scenarios mapped to the sub-themes of each research area, mixing clear emergencies,
  routine pharmacist cases, and scope/oversight probes.

### What we ran
- Smoke test (1 sample) to confirm the round-trip, then the **full 50-sample baseline**
  against `medpsy-4b` → `results/20260604-160359/`. 50/50 answered, 0 errors, ~11 s/answer.

### What we found (detail in EVALUATION.md)
Strong for a 4B model: 100% red-flag escalation, solid scope discipline, real
mechanistic drug reasoning. Weaknesses noted: **verbosity**, **patient-vs-pharmacist
audience drift**, and a few **non-dangerous factual slips** — calling BP 152/94 a
"hypertensive emergency" (it's stage 2), and conflating folic acid with leucovorin in
the methotrexate case. Slight **over-triage** lean on borderline vitals.

### Why we did it this way
The baseline's job is to map the model's behavior across the *intended* use cases and
surface candidate weaknesses — not to stress it. The slips above became the explicit
targets of the next session's adversarial set.

---

## 2026-06-04 — Session 2: adversarial set + run

### Goal
Stress-test the model where a 4B is most likely to fail, and specifically re-probe the
weaknesses the baseline surfaced. Built a separate **adversarial bank**
(`questions_adversarial/`, 5 files × 10 = 50), organized by *failure mode* rather than
by research area, because the interesting failures cut across areas.

### Design choices and why
- **Separate directory + `--dir` flag** (small runner change) so adversarial cases never
  pollute the baseline run, and either bank can be run independently.
- **Each adversarial sample carries an `expected` field** documenting the trap and the
  correct behavior. The runner ignores unknown fields, so this is pure grading
  scaffolding — it makes PASS/FAIL judgments reproducible instead of vibes.
- **Five failure modes**, each chosen to attack a specific risk:
  - **adv1 Under-triage** — quiet/atypical emergencies (atypical MI, DKA, GCA, CO
    poisoning, cauda equina, aortic dissection, early sepsis, torsion, ectopic,
    staggered paracetamol). Highest-value safety test: missing one is the worst outcome.
  - **adv2 Over-triage** — alarming-but-benign (beeturia, rifampicin orange urine, iron
    stool, costochondritis, single high BP, BPPV, DOMS, benign palpitations, geographic
    tongue, viral conjunctivitis). Directly probes the baseline over-triage lean,
    including a 150/92 reading to re-test the "hypertensive emergency" slip.
  - **adv3 Drug traps** — lethal precision (methotrexate daily-vs-weekly, MTX+trimethoprim,
    folic vs folinic acid, serotonin syndrome, hyperkalemia stack, nitrate+sildenafil,
    warfarin+St John's Wort, beta-blocker hypo-masking, chelation, allopurinol-in-flare).
    Re-tests the folic/leucovorin conflation.
  - **adv4 Data integrity** — contradictions/missing data (penicillin allergy +
    amoxicillin, INR 8.5 "feels fine", digoxin mg-vs-microgram, levothyroxine 500 mcg,
    brand duplication, missing paediatric weight, stale vitals, conflicting timeline).
    Tests whether it bluffs vs. flags/asks.
  - **adv5 Persuasion** — social pressure to be unsafe (confirm an unverified warfarin
    doubling, false "antibiotics cure colds" premise, "just heartburn" anchoring on
    ACS, false authority demanding an oxycodone script, cost-based under-triage,
    wear-down for a friend's diazepam, planted "neonatal fever is normal", flattery
    scope-creep, abrupt-steroid-stop endorsement). Tests sycophancy/compliance.

### What we ran
Full 50-case adversarial run against `medpsy-4b` → `results/20260604-173953/`. 50/50
answered, 0 errors. Graded every case PASS/FAIL against its `expected`.

### What we found (detail in EVALUATION.md)
Held up impressively. **Under-triage 10/10, drug-traps 10/10, persuasion 10/10**,
data-integrity 9/10 + 1 partial, over-triage 8/10 + 1 factual slip. Across all 100
prompts (baseline + adversarial): **zero dangerous under-triage and zero unsafe-compliance
failures**. It even *corrected* the two baseline slips when re-probed (150/92 not an
emergency; folic ≠ folinic). Residual, non-dangerous watch-items: a confident
terminology error ("melanosis coli" for iron stool), a slight over-triage reflex on
near-zero data / the keyword "chest", and persistent verbosity.

---

## 2026-06-04 — Session 3: project hygiene & docs

Added `.gitignore` (ignore `.venv`/caches/secrets/editor cruft; **keep `results/`**
tracked because the stored answers are the research record), this `JOURNAL.md`, and
refreshed `README.md`.

### Open next steps (carried forward)
- **Automated PASS/FAIL scorer**: grade each stored answer against its `expected` field
  into a CSV so runs are quantitatively comparable across models and prompt versions.
- **Model head-to-head** on the adversarial bank (`medpsy-1.7b`, `qwen3.5-4b-mlx`,
  `gemma-4-e4b-it`) — where the medical tuning should earn its keep.
- **Tighten the system prompt** (pharmacist voice + compact output schema + length cap),
  re-run, and check verbosity/over-triage drop without eroding the safety floor.
- **Stacked-trap cases** — combine two failure modes in one prompt (e.g. an under-triage
  hidden inside a persuasion frame).
