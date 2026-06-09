# medpsy-qvac — local-first pharmacist triage kiosk (QVAC)

A privacy-preserving, **on-device** community-pharmacy triage assistant. It runs the
**medpsy** medical model locally, walks a patient through a guided multi-step triage,
returns a structured, colour-coded decision, and **grounds the ICD-10 code against a
real on-device index** instead of trusting the model's hallucinated codes. Multilingual,
voice-enabled (speak + listen + read-aloud), human-in-the-loop.

Built for the **[QVAC SDK](https://docs.qvac.tether.io)** (Tether's local-first AI platform).
During development everything runs against **LM Studio** + on-device speech engines — same
code, flip one env var for the QVAC backend.

## What's in here
- **Web kiosk** (`web/`) — the 9-step patient/clinician flow (React + Vite). The main app.
- **API server** (`src/server.js`) — ICD-10 grounding (`/api/icd`), TTS (`/api/tts`), STT (`/api/stt`).
- **CLI** (`src/cli.js`) — headless triage for one complaint.
- **Speech** (`src/speech.js` + `scripts/*_worker.py`) — on-device STT & multilingual TTS.

## Quick start (the kiosk)

**Prerequisite (manual): LM Studio** — load `medpsy-4b` (or 1.7b) + `text-embedding-nomic-embed-text-v1.5`
and enable the local server on `:1234`.

```bash
cd qvac-app
npm install
npm run check            # ▶ what's available? per-model status + sizes + how to get what's missing
npm run download-models  # ▶ fetch the downloadable models (Nemotron GGUF ~940 MB, Kokoro ~340 MB)
npm run start            # ▶ run it all: preflight → API server (:8787) → web kiosk (Vite)
```

`npm run start` prints the Vite URL — open it. (Vite proxies `/v1`→LM Studio `:1234`, `/api`→API `:8787`.)

> **`npm run check`** is your friend — it reports exactly which models/engines are present, their sizes,
> and how to get the missing ones. The parakeet.cpp **STT engine must be built** (it can't be downloaded —
> see the `../nemotron-asr-test` harness); the **GGUF + Kokoro model files** can be auto-downloaded.

<details><summary>…or run the three processes manually</summary>

```bash
npm run build-icd-index     # one-time: embed ~12k WHO ICD-10 descriptions (cached)
npm run serve               # API server :8787 (ICD + speech; pre-warms STT/TTS models)
cd web && npm install && npm run dev    # web kiosk, Vite free port (often :5175)
```
</details>

> **CLI instead of the kiosk:**
> `node src/cli.js "58, crushing chest pressure 40 min, spreading to jaw, sweaty, breathless"`

## Servers & models at a glance

| Piece | Where | Default port | Backed by |
|---|---|---|---|
| **LLM** (triage + SBAR + embeddings) | LM Studio (or QVAC SDK) | `:1234` | `medpsy-4b` + `nomic-embed` |
| **API server** | `npm run serve` | `:8787` | Node; ICD index + speech endpoints |
| **Web kiosk** | `web/ npm run dev` | `:5173`+ | Vite/React; proxies to the two above |
| **STT** (speech→text) | API → `scripts/stt_worker.py` | — | **Nemotron-3.5-ASR** via parakeet.cpp (C-API) |
| **TTS** (read-aloud) | API → `scripts/tts_worker.py` | — | **Kokoro-82M v1.0** via `kokoro-onnx` (multilingual) |
| **ICD-10** | API `/api/icd` | — | on-device cosine/sqlite over `data/icd10.json` |

### ⚠️ Dev coupling — the speech models come from the sibling harness
On-device speech currently borrows binaries/models/venv from the **`nemotron-asr-test`** sibling
project (see its README to build parakeet.cpp + fetch the models). The kiosk references them via
symlinks in `models/` (gitignored) and the harness's Python venv:

```
models/parakeet-cli, libparakeet.dylib            -> nemotron-asr-test/parakeet.cpp/build/...
models/nemotron-3.5-asr-streaming-0.6b-q8_0.gguf  -> nemotron-asr-test/models/...
models/kokoro-v1.0.onnx, voices-v1.0.bin          -> nemotron-asr-test/models/kokoro/...
TTS worker python                                 -> nemotron-asr-test/.venv/bin/python (has kokoro-onnx)
```
All overridable by env (below). On a real QVAC device, speech runs through the SDK instead
(`MEDPSY_STT_ENGINE=qvac`). If a speech model is missing, the kiosk degrades gracefully
(the mic/read-aloud just show as unavailable; everything else works).

## Backends (LLM)
| `MEDPSY_BACKEND` | Inference by | Use when |
|---|---|---|
| `lmstudio` (default) | your running LM Studio (`:1234`) | dev today, no native build |
| `qvac` | the QVAC SDK on-device | the real local-first build |

The triage prompt + ICD-RAG logic is identical; only the provider changes (`src/backends/`).

## On-device speech (STT / TTS)

- **STT — Nemotron-3.5-ASR (40 locales).** The browser records the mic, encodes 16 kHz mono WAV,
  and POSTs to `/api/stt`. The server runs a persistent **parakeet.cpp** worker (model resident →
  ~0.13 s/clip). *No cloud Web Speech API.* Engine chain `MEDPSY_STT_ENGINE`:
  `parakeet-server` → `parakeet-cli` → `qvac`.
- **TTS — Kokoro-82M v1.0 (multilingual).** `/api/tts` runs a persistent Python **`kokoro-onnx`**
  worker that synthesizes with the **correct language per voice** (`ff_siwis`→French, `zf_*`→Mandarin…).
  *(kokoro-js, the Node package, is English-only and was replaced for this reason.)*
- **Languages.** UI is translated into **8**: English, Deutsch, Français, Español, Italiano,
  Slovenščina, 中文 (Mandarin), 粵語 (Cantonese). Speech support varies — shown live on step 1:
  | | STT (Nemotron) | TTS voice (Kokoro) |
  |---|---|---|
  | en / fr / es / it | ✓ | ✓ |
  | zh (Mandarin) | ✓ | ✓ |
  | de | ✓ | ✗ → English voice |
  | sl | ≈ beta | ✗ → English voice |
  | yue (Cantonese) | ✗ | ✗ → Mandarin voice |

```bash
# headless speech (16 kHz mono WAV)
node src/speech.js tts "Do you have chest pain?" out.wav
node src/speech.js stt clip.wav
```

## Environment variables
All optional; defaults target a local LM Studio + the sibling harness. Copy `.env.example` → `.env`.

| Var | Default | Purpose |
|---|---|---|
| `MEDPSY_BACKEND` | `lmstudio` | `lmstudio` \| `qvac` |
| `LMSTUDIO_URL` | `http://localhost:1234` | LLM endpoint |
| `MEDPSY_LLM` / `MEDPSY_EMBED` | `medpsy-4b` / `…nomic…` | model ids in LM Studio |
| `API_PORT` | `8787` | API server port |
| `ICD_INDEX` | `sqlite` | `sqlite` (`@sqliteai/sqlite-wasm`) \| `flat` (cosine, no deps) |
| `MEDPSY_STT_ENGINE` | `auto` | `parakeet-server` \| `parakeet-cli` \| `qvac` |
| `MEDPSY_PARAKEET_BIN` / `_LIB` / `MEDPSY_STT_GGUF` | `models/…` | parakeet-cli, libparakeet, Nemotron GGUF |
| `MEDPSY_TTS_ENGINE` | `kokoro` | `kokoro` (onnx worker) \| `supertonic` |
| `MEDPSY_KOKORO_PY` | harness `.venv` python | Python with `kokoro-onnx` |
| `MEDPSY_KOKORO_ONNX` / `_VOICES` | `models/…` | Kokoro v1.0 ONNX + voices |
| `MEDPSY_SPEECH_LANG` | `auto` | Nemotron `--lang` |

## Architecture
```
patient complaint ─► triage.js ─ provider.complete() ─► medpsy (LLM)   [LM Studio | QVAC]
                          │        DECISION/SEVERITY/RED FLAGS/CONDITION/…
                          ▼
                     icd.js ─ provider.embed(CONDITION) ─► cosine over on-device ICD index
                          ▼            (data/icd10.json — 12k WHO codes)
                  verified ICD-10 code ─► grounded, colour-coded triage result
```
See `ARCHITECTURE.md` for the full kiosk flow (consent, conditional history re-triage, SBAR
handover, clinician sign-off + signed outcome record, billing).

## How this maps to the parent eval repo
Productizes `../EVALUATION.md` / `../JOURNAL.md`: triage prompt ← `prompts/system_interview.txt`;
ICD grounding ← `icd_lookup.py`; `data/icd10.json` ← `scripts/export_icd.py` (12,246 codes).

## Roadmap (QVAC-native)
Swap flat cosine for `@qvac/rag`; P2P delegated inference for hard cases; bundle the speech
models so the kiosk no longer borrows from the harness; LoRA fine-tune to a clinic's formulary.
