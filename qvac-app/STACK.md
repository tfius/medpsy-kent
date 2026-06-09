# Stack — what we use, what model, where it runs

A map of every capability in the app: the model behind it, where it's served, and
whether it's provided by the **QVAC SDK**, **LM Studio** (dev), our **own code**, or
the **browser**. Everything runs **fully local / offline** — no cloud APIs (the only
exception is the browser Web Speech TTS fallback, used only if the `:8787` API is down).

## 1. Master matrix — capability → model → where it runs → who provides it

| # | Capability | Model (quant) | Runs / served on | Library / provider | QVAC SDK? | Own code? |
|---|---|---|---|---|---|---|
| 1 | **LLM triage reasoning** | medpsy-4b (`q4_k_m-imat`); medpsy-1.7b (`q5_k_m`) available | **dev:** LM Studio `:1234` · **prod:** on-device | OpenAI `/v1` (dev) / QVAC `completion` (llama.cpp) | ✅ prod path | provider abstraction |
| 2 | **Embeddings** (ICD grounding) | **dev:** nomic-embed-text-v1.5 (768-d) · **prod:** GTE-large (fp16, 1024-d) | same backends as LLM | LM Studio `/v1/embeddings` / QVAC `embed` | ✅ prod path | — |
| 3 | **ICD-10 vector search** | — (cosine over 12,246 vectors) | Node, in-process `:8787` | **own** flat-cosine; optional SQLite-vector (`@sqliteai`) | ❌ (roadmap: `@qvac/rag`) | ✅ `icd.js` |
| 4 | **ICD-10 knowledge base** | WHO ICD-10, 12,246 codes (768-d index, 37 MB) | static files in `data/` | exported via `simple-icd-10` | ❌ | ✅ |
| 5 | **STT (speech→text)** | Nemotron-3.5-ASR-streaming-0.6b (`q8_0`) | `:8787` → subprocess | **own** parakeet.cpp (lib/CLI) → QVAC fallback | ✅ fallback only | ✅ engine chain |
| 6 | **TTS (text→speech)** | Kokoro-82M-v1.0-ONNX (**multilingual**, 54 voices) | `:8787` → **Python worker** | **own** kokoro-onnx (persistent worker) → Supertonic fallback | ✅ fallback (Supertonic) | ✅ engine chain |
| 7 | **TTS last-resort** | OS voices | browser | Web Speech API | ❌ | browser |
| 8 | **Mic capture + 16 kHz WAV** | — | browser | MediaRecorder + AudioContext (VAD auto-stop, barge-in) | ❌ | ✅ `web/src/lib/speech.ts` |
| 9 | **Outcome signing** | SHA-256 hash | browser | Web Crypto `subtle.digest` | ❌ | ✅ `web/src/lib/sign.ts` |
| 10 | **UI / kiosk** | — | browser (Vite, free port — often `:5175`) | React 18 + Vite + react-router | ❌ | ✅ |
| 11 | **i18n** | — | browser | **8 languages**: en, de, fr, es, it, sl, zh, yue | ❌ | ✅ |

> **TTS note:** the Node package `kokoro-js` is **English-only** (its JS phonemizer has no
> Chinese/Japanese G2P), so real multilingual TTS runs through a **Python `kokoro-onnx` worker**
> (`scripts/tts_worker.py`) that phonemizes by language. en/fr/es/it/zh have native voices;
> de/sl have none (→ English voice); yue uses a Mandarin voice.

## 2. What's served where (processes & ports)

| Endpoint / process | Port | Started by | Serves |
|---|---|---|---|
| **LM Studio** | `:1234` | you (external) | LLM + embeddings, OpenAI `/v1` (dev backend) |
| **ICD + speech API** | `:8787` | `npm run serve` (`src/server.js`) | `/api/icd`, `/api/tts`, `/api/tts/voices`, `/api/stt`, `/api/health` |
| **Parakeet STT worker** | — (subprocess) | spawned by `:8787` | `python3` + `libparakeet.dylib`, keeps Nemotron resident |
| **Kokoro TTS worker** | — (subprocess) | spawned by `:8787` | `python` + `kokoro-onnx`, keeps Kokoro resident (multilingual) |
| **Vite kiosk** | free port (often `:5175`) | `npm run dev` (in `web/`) | the React app; proxies `/v1→:1234`, `/api→:8787` |

**One-command stack:** `npm run start` (preflight → API server → web). `npm run check`
reports model/dependency availability + sizes; `npm run download-models` fetches the
downloadable model files (Nemotron GGUF, Kokoro). The parakeet.cpp engine must be **built**
(see `../nemotron-asr-test`) and LM Studio set up by you.

## 3. QVAC SDK — what we use it for vs. bypass

| QVAC SDK capability | Status in this app | Why |
|---|---|---|
| `completion` (on-device LLM) | **Prod path** (backend=`qvac`); dev uses LM Studio | identical logic, switch via `MEDPSY_BACKEND` |
| `embed` (on-device embeddings) | **Prod path** (GTE-large); dev uses nomic | note: 768-d vs 1024-d → index rebuild on switch |
| `transcribe` (parakeet) | **Fallback** behind parakeet.cpp | native Bare worker is fragile; parakeet.cpp is the reliable primary |
| `textToSpeech` (Supertonic) | **Fallback** behind Kokoro | same — Kokoro (kokoro-onnx) avoids the native build |
| `@qvac/rag` (ragIngest/Search) | **Not used** (roadmap) | own flat-cosine works today |

## 4. The key architectural decision

> **QVAC SDK is the hackathon target, but its native "Bare" worker install is fragile.**
> So for the two speech capabilities we built **local bypasses that mirror QVAC** —
> **Kokoro** (TTS, via a persistent `kokoro-onnx` Python worker — the Node `kokoro-js` is
> English-only) and **parakeet.cpp** (STT, persistent Python worker) — and kept the QVAC SDK
> engines wired as **automatic fallbacks**. The LLM/embeddings keep a clean two-backend abstraction
> (LM Studio ↔ QVAC) behind one provider interface (`src/backend.js`). Everything stays
> **fully local / offline** either way.

## 5. Engine-selection env vars

| Var | Default | Options | Controls |
|---|---|---|---|
| `MEDPSY_BACKEND` | `lmstudio` | `lmstudio` \| `qvac` | LLM + embeddings provider |
| `ICD_INDEX` | `sqlite` | `sqlite` \| `flat` | ICD vector-search backend (falls back to `flat`) |
| `MEDPSY_STT_ENGINE` | `auto` | `auto` \| `parakeet-server` \| `parakeet-cli` \| `qvac` | STT engine (auto prefers the resident worker) |
| `MEDPSY_TTS_ENGINE` | `kokoro` | `kokoro` \| `supertonic` | TTS engine (then falls back to the other) |
| `MEDPSY_TTS_VOICE` | `af_heart` | multilingual Kokoro voices (en/de/fr/es/it/zh/…) | default TTS voice |
| `MEDPSY_KOKORO_PY` | harness `.venv` python | path | Python interpreter that has `kokoro-onnx` |
| `MEDPSY_KOKORO_ONNX` / `_VOICES` | `models/kokoro-v1.0.onnx` / `voices-v1.0.bin` | path | Kokoro model + voices |
| `MEDPSY_PARAKEET_BIN` / `_LIB` / `MEDPSY_STT_GGUF` | `models/…` | path | parakeet-cli, libparakeet, Nemotron GGUF |
