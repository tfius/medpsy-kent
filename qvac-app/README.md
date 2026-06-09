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

## Installation

**Prerequisites:** macOS (Apple Silicon) or Linux · **Node 18+** · **Python 3.9+** · `git`, `curl`,
`cmake` + a C++17 compiler (only needed to build the STT engine) · **[LM Studio](https://lmstudio.ai)**.

```bash
# 1) the kiosk itself
git clone <this-repo> && cd medpsy-kent/qvac-app
npm install                       # API server deps (@qvac/sdk is optional)
( cd web && npm install )         # web kiosk deps
```

**2) LLM — LM Studio.** Install LM Studio, download **`medpsy-4b`** (or `medpsy-1.7b`) and
**`text-embedding-nomic-embed-text-v1.5`**, and enable the local server on `:1234`.
(For the on-device QVAC backend instead, set `MEDPSY_BACKEND=qvac` + `MEDPSY_GGUF`.)

**3) Speech engines (optional — the kiosk runs fine without; voice features just show as unavailable).**

*STT — build parakeet.cpp* (produces `libparakeet.dylib` + `parakeet-cli`; can't be downloaded):
```bash
brew install cmake                # Linux: apt install cmake build-essential
git clone --recursive https://github.com/mudler/parakeet.cpp && cd parakeet.cpp
# if the ggml submodule is empty, fetch it directly into third_party/ggml first
cmake -B build -DPARAKEET_BUILD_CLI=ON -DPARAKEET_SHARED=ON -DPARAKEET_GGML_METAL=ON   # drop METAL on Linux
cmake --build build -j
# point the kiosk at the outputs (or set MEDPSY_PARAKEET_LIB / MEDPSY_PARAKEET_BIN)
ln -sf "$PWD/build/libparakeet.dylib"            ../models/
ln -sf "$PWD/build/examples/cli/parakeet-cli"    ../models/
```

*TTS — kokoro-onnx* (Python; multilingual):
```bash
python3 -m venv ~/.kokoro-venv && ~/.kokoro-venv/bin/pip install kokoro-onnx
export MEDPSY_KOKORO_PY="$HOME/.kokoro-venv/bin/python"   # add to your shell rc / .env
```

*Model files* (Nemotron GGUF + Kokoro ONNX + voices → `models/`):
```bash
npm run download-models           # Nemotron ~940 MB + Kokoro ~340 MB, via curl
```

> **Shortcut:** these speech engines + models are exactly what the sibling **`../nemotron-asr-test`**
> harness builds. If you've set it up, the kiosk already symlinks to it — `npm run check` will say so.

**4) Verify & run:**
```bash
npm run check                     # per-model status + sizes + how to fix anything missing
npm run start                     # preflight → API (:8787) → web kiosk (prints the URL)
```

## Running

Once installed, **one command** runs the whole stack (make sure LM Studio is up first):
```bash
npm run start     # preflight → API server (:8787) → web kiosk → prints the Vite URL
```
`npm run check` anytime to re-check model/dependency status. Vite proxies `/v1`→LM Studio `:1234`,
`/api`→API `:8787`. Anything missing degrades gracefully (that feature just shows as unavailable).

<details><summary>…or run the three processes manually</summary>

```bash
npm run build-icd-index     # one-time: embed ~12k WHO ICD-10 descriptions (cached)
npm run serve               # API server :8787 (ICD + speech; pre-warms STT/TTS models)
cd web && npm run dev       # web kiosk, Vite free port (often :5175)
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
