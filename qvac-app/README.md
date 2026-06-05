# medpsy-qvac — local-first pharmacist triage (QVAC)

A privacy-preserving, **on-device** community-pharmacy triage assistant. It runs the
**medpsy** medical model locally, triages a patient's complaint into a structured,
colour-coded decision, and — crucially — **grounds the ICD-10 code against a real
on-device index** instead of trusting the model's hallucinated codes.

Built to run on the **[QVAC SDK](https://docs.qvac.tether.io)** (Tether's local-first,
P2P AI platform). During development it can also run against **LM Studio** — same code,
flip one env var.

## Why
- **Privacy:** patient data never leaves the device — no cloud, no third-party API.
- **Offline:** works in low-connectivity pharmacies, ambulances, field clinics.
- **Safe coding:** the model is unreliable at ICD-10 (measured **~15% exact, ~30% invalid**
  in the parent repo); a deterministic **embeddings/RAG lookup** recovers **~85% exact**.
- **Human-in-the-loop:** decision-support only; the pharmacist holds the final word.

## Backends (pick one)
| `MEDPSY_BACKEND` | Inference by | Use when |
|------------------|--------------|----------|
| `lmstudio` (default) | your running LM Studio (`:1234`, medpsy-4b + nomic) | dev today, no native build |
| `qvac` | the QVAC SDK on-device (`loadModel`/`completion`/`embed`) | the real local-first build |

The logic (triage prompt + ICD RAG) is identical; only the provider changes
(`src/backends/`).

## Setup
```bash
cd qvac-app
npm install                      # @qvac/sdk is optional — LM Studio mode needs nothing native
```
The medpsy GGUF is referenced via a symlink in `models/` (not committed). For the QVAC
backend, point at any local `.gguf`:
```bash
export MEDPSY_GGUF=/path/to/medpsy-4b.gguf     # default: ./models/medpsy-4b.gguf
```

## Run
```bash
# 1) build the on-device ICD-10 index once (embeds ~12k descriptions, cached)
npm run build-icd-index

# 2) triage a patient (LM Studio backend by default)
node src/cli.js "I'm 58 with crushing chest pressure for 40 min spreading to my jaw, sweaty and breathless"

# switch to the QVAC SDK (on-device) once @qvac/sdk is installed:
MEDPSY_BACKEND=qvac node src/cli.js "..."
```

Example output:
```
DECISION:   EMERGENCY
SEVERITY:   9 / RED
RED FLAGS:  central chest pressure radiating to jaw, diaphoresis, dyspnoea
CONDITION:  acute coronary syndrome
ROUTING:    call EMS now; do not drive
ICD-10 (verified on-device):
  I21.9  Acute myocardial infarction, unspecified   [score 0.78]
  (medpsy's own guess was: I20.0 ... — replaced with the verified code)
```

## Architecture
```
patient complaint
      │
      ▼
 triage.js ── provider.complete() ──►  medpsy (LLM)            ┐ backend = LM Studio (dev)
      │            DECISION/SEVERITY/RED FLAGS/CONDITION/...    │            or QVAC SDK (prod)
      ▼                                                         │
 icd.js ── provider.embed(CONDITION) ─► cosine over ICD index ─┘
      │            (built from data/icd10.json, 12k WHO codes)
      ▼
 verified ICD-10 code  ──►  grounded triage result
```

## How this maps to the parent eval repo
This app productizes the findings in `../EVALUATION.md` / `../JOURNAL.md`:
- triage prompt ← `prompts/system_interview.txt` / `system_v4.txt`
- ICD grounding ← `icd_lookup.py` (semantic search over WHO ICD-10) → here via `provider.embed`
- `data/icd10.json` ← exported by `scripts/export_icd.py` (`simple-icd-10`, 12,246 codes)

## Roadmap (QVAC-native)
- Swap the flat cosine index for **`@qvac/rag`** (`ragIngest`/`ragSearch`, HyperDB / LanceDB).
- **P2P delegated inference:** route hard/uncertain cases to a bigger model on a peer.
- **Multimodal:** OCR a paper prescription/intake form; STT for phone-triage calls.
- **LoRA** fine-tune medpsy to a clinic's local formulary.
