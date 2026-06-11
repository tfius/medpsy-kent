# Stack — what we use, what model, where it runs

A map of every capability in the app: the model behind it, where it's served, and
whether it's provided by the **QVAC SDK**, **LM Studio** (dev), our **own code**, or
the **browser**. Everything runs **fully local / offline** — no cloud APIs (the only
exception is the browser Web Speech TTS fallback, used only if the `:8787` API is down).

## 1. Master matrix — capability → model → where it runs → who provides it

| # | Capability | Model (quant) | Runs / served on | Library / provider | QVAC SDK? | Own code? |
|---|---|---|---|---|---|---|
| 1 | **LLM triage reasoning** | medpsy-4b (`q4_k_m-imat`); medpsy-1.7b (`q5_k_m`) available | **dev:** LM Studio `:1234` · **prod:** on-device | OpenAI `/v1` (dev) / QVAC `completion` (llama.cpp) | ✅ prod path | provider abstraction |
| 2 | **Embeddings** (ICD grounding) | **nomic-embed-text-v1.5 (768-d)** — dev via LM Studio, prod via a **local nomic gguf** (no P2P; not GTE-large) | same backends as LLM | LM Studio `/v1/embeddings` / QVAC `embed` (local gguf) | ✅ prod path | — |
| 3 | **ICD-10 vector search** | — (cosine over 12,246 vectors) | Node, in-process `:8787` | **own** flat-cosine; optional SQLite-vector (`@sqliteai`) | ❌ (`@qvac/rag` evaluated, far worse — see §3) | ✅ `icd.js` |
| 4 | **ICD-10 knowledge base** | WHO ICD-10, 12,246 codes (768-d index, 37 MB) | static files in `data/` | exported via `simple-icd-10` | ❌ | ✅ |
| 5 | **STT (speech→text)** | Nemotron-3.5-ASR-streaming-0.6b (`q8_0`); **Cantonese → SenseVoice-Small** (int8) | `:8787` → subprocess | **own** parakeet.cpp (lib/CLI) → QVAC fallback; **sherpa-onnx** for yue | ✅ fallback only | ✅ engine chain |
| 6 | **TTS (text→speech)** | Kokoro-82M-v1.0-ONNX (**multilingual**, 54 voices); **Cantonese → vits-cantonese-hf-xiaomaiiwn** | `:8787` → **Python worker** | **own** kokoro-onnx (persistent worker) → Supertonic fallback; **sherpa-onnx** VITS for yue | ✅ fallback (Supertonic) | ✅ engine chain |
| 7 | **TTS last-resort** | OS voices | browser | Web Speech API | ❌ | browser |
| 8 | **Mic capture + 16 kHz WAV** | — | browser | MediaRecorder + AudioContext (VAD auto-stop, barge-in) | ❌ | ✅ `web/src/lib/speech.ts` |
| 9 | **Outcome signing** | SHA-256 hash | browser | Web Crypto `subtle.digest` | ❌ | ✅ `web/src/lib/sign.ts` |
| 10 | **UI / kiosk** | — | browser (Vite, free port — often `:5175`) | React 18 + Vite + react-router | ❌ | ✅ |
| 11 | **i18n** (static UI strings) | — | browser | **8 languages**: en, de, fr, es, it, sl, zh, yue | ❌ | ✅ |
| 12 | **Live translation** (patient ↔ medpsy) | **dev:** gemma-4-26b-a4b-it · **prod:** on-device LLM | LLM backend (LM Studio `:1234` dev) | OpenAI `/v1` w/ a **separate model** (medpsy reasons in English) | ✅ prod path | ✅ `web/src/lib/translate.ts` |
| 13 | **Audit log** (per patient) | — (SHA-256 hash-chain) | `:8787` → `audit/<encounterId>.jsonl` | **own** append-only, tamper-evident; raw model I/O + all UI events | ❌ | ✅ `src/audit.js`, `web/src/lib/audit.ts`, `web/src/pages/Audit.tsx` |

> **TTS note:** the Node package `kokoro-js` is **English-only** (its JS phonemizer has no
> Chinese/Japanese G2P), so real multilingual TTS runs through a **Python `kokoro-onnx` worker**
> (`scripts/tts_worker.py`) that phonemizes by language. en/fr/es/it/zh have native voices;
> de/sl have none (→ English voice).
>
> **Cantonese (yue) note:** Kokoro has no Cantonese voice and Nemotron can't transcribe
> Cantonese, so when the UI language is Cantonese the server routes speech to dedicated
> **sherpa-onnx** models via two persistent Python workers — **SenseVoice-Small** (STT,
> `scripts/sherpa_stt_worker.py`) and the **Cantonese VITS** `vits-cantonese-hf-xiaomaiiwn`
> (TTS, `scripts/sherpa_tts_worker.py`). This activates **only** for `yue` (routed by
> `lang=yue` on `/api/stt` and `/api/tts`, and the `yue_canto` voice id); every other
> language is untouched. If the sherpa models/venv are absent it degrades gracefully
> (STT → Nemotron, TTS → Mandarin Kokoro voice). Needs `sherpa-onnx` in the kokoro venv.
> (We use the sherpa-native Cantonese VITS rather than `mms-tts-yue` — sherpa-onnx doesn't
> package MMS-yue, and this avoids a torch conversion while giving a real Cantonese voice.)
>
> **Translation note:** medpsy reasons **only in English**, so for non-English patients the
> triage conversation is conducted in English *internally* and translated at the boundary —
> patient text → English before each medpsy call, medpsy's question/verdict → patient language
> after (for display + TTS). medpsy never translates; a **separate LLM** (`gemma-4-26b-a4b-it`
> in dev) does, through the same `/v1` proxy (`web/src/lib/translate.ts`). Invariant: the medpsy
> message history is always English, the chat UI is always the patient's language. The stored
> outcome stays **English** (SBAR handover, `/api/icd` grounding and clinician sign-off need
> canonical English); only the patient-visible verdict fields (`routing`, `safetyNet`) are
> translated for display. **Fails safe** — if the translation model is absent, triage degrades to
> the patient's own words rather than breaking; English is a pure no-op. Override the model with
> `VITE_TRANSLATE_MODEL`. **Model eval (see JOURNAL):** gemma-4-26b is fast (~1-2 s) and fluent for
> fr/es/it/de/zh/yue but corrupts **Slovenian** red flags; qwen3.6-27b-optiq nails Slovenian but is a
> runaway reasoning model (50-167 s/call — unusable live). So **`sl` outbound (English→patient) is
> disabled** (`NO_TRANSLATE_OUT` in `translate.ts`): Slovenian patients see medpsy's questions/advice
> in English, while their input is still translated **into** English (reliable) so medpsy reasons on
> their real words. (`sl` is already a `limited` language: beta STT, no native voice.)
>
> **Audit note:** every encounter writes an append-only, **hash-chained** JSONL at
> `audit/<encounterId>.jsonl` (one per patient; new id on "New patient"). Each event is
> `{seq, ts, type, actor, data, prevHash, hash}` with `hash = sha256(canonical(event))`, so
> any edit/deletion/reorder is detectable. Two writers, one stream: the **`/v1` shim logs raw
> model I/O** (full prompt + raw completion incl. `<think>`), and the client POSTs UI events
> (`stage.enter`, `patient`, `consent`, `message.user/assistant`, `stt`, `tts`, `translation`,
> `icd`, `outcome`, `signoff`) — correlated by `encounterId`. API: `POST /api/audit` (append),
> `GET /api/audit` (list), `GET /api/audit/:id` (events+verify), `…/verify`, `…/export` (signed
> bundle), `POST /api/audit/import` (verify + view). The **Audit page** (`/audit`) lists patients,
> shows the timeline with an integrity badge, and exports/imports shareable bundles. Logs are PHI
> → stored on-device only, gitignored; `MEDPSY_AUDIT_DIR` / `MEDPSY_AUDIT_KEY` configure path + signing.

## 2. What's served where (processes & ports)

| Endpoint / process | Port | Started by | Serves |
|---|---|---|---|
| **LM Studio** | `:1234` | you (external) | LLM (medpsy) + embeddings + **translation model** (`gemma-4-26b-a4b-it`), OpenAI `/v1` (dev backend) |
| **ICD + speech API** | `:8787` | `npm run serve` (`src/server.js`) | `/api/icd`, `/api/tts`, `/api/tts/voices`, `/api/stt`, `/api/health`, `/api/audit*`, `/v1/*` (shim) |
| **Parakeet STT worker** | — (subprocess) | spawned by `:8787` | `python3` + `libparakeet.dylib`, keeps Nemotron resident |
| **Kokoro TTS worker** | — (subprocess) | spawned by `:8787` | `python` + `kokoro-onnx`, keeps Kokoro resident (multilingual) |
| **SenseVoice + Cantonese-VITS workers** | — (subprocess) | spawned by `:8787` on first `yue` request | `python` + `sherpa-onnx`, Cantonese STT/TTS (resident) |
| **Vite kiosk** | free port (often `:5175`) | `npm run dev` (in `web/`) | the React app; proxies `/v1→:1234`, `/api→:8787` |

**Running fully on QVAC (no LM Studio):** the API server exposes an OpenAI-compatible
shim (`/v1/chat/completions` streaming + `/v1/embeddings` + `/v1/models`) backed by the
provider abstraction, so the web UI needs no change — just repoint its `/v1` proxy:
```bash
MEDPSY_BACKEND=qvac npm run serve              # LLM + embeddings + ICD all via @qvac/sdk
VITE_LLM_URL=http://localhost:8787 npm run dev # /v1 → the on-device shim (not LM Studio)
```
In dev (default) `/v1` still proxies straight to LM Studio `:1234`; the shim path is what
makes the kiosk run 100% on-device.

**One-command stack:** `npm run start` (preflight → API server → web). `npm run check`
reports model/dependency availability + sizes; `npm run download-models` fetches the
downloadable model files (Nemotron GGUF, Kokoro, and the optional Cantonese sherpa-onnx
archives — SenseVoice STT + Cantonese VITS TTS). The parakeet.cpp engine must be **built**
(see `../nemotron-asr-test`) and LM Studio set up by you.

## 3. QVAC SDK — what we use it for vs. bypass

| QVAC SDK capability | Status in this app | Why |
|---|---|---|
| `completion` (on-device LLM) | **Prod path** (backend=`qvac`); dev uses LM Studio | identical logic, switch via `MEDPSY_BACKEND` |
| `embed` (on-device embeddings) | **Prod path** (GTE-large); dev uses nomic | note: 768-d vs 1024-d → index rebuild on switch |
| `transcribe` (parakeet) | **Fallback** behind parakeet.cpp | native Bare worker is fragile; parakeet.cpp is the reliable primary |
| `textToSpeech` (Supertonic) | **Fallback** behind Kokoro | same — Kokoro (kokoro-onnx) avoids the native build |
| `@qvac/rag` (ragIngest/Search) | **Evaluated → rejected** for ICD | A/B on 20 cases: cosine 80% top-1 vs @qvac/rag 5% (same nomic embeddings; rag is for chunked doc-RAG, not 12k-row exact-label lookup). Kept exact-cosine/sqlite-vector. |

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
| `VITE_TRANSLATE_MODEL` | `gemma-4-26b-a4b-it` | any LM Studio model id | translation model (patient ↔ English for medpsy); build-time web env |
| `ICD_INDEX` | `sqlite` | `sqlite` \| `flat` | ICD vector-search backend (falls back to `flat`) |
| `MEDPSY_STT_ENGINE` | `auto` | `auto` \| `parakeet-server` \| `parakeet-cli` \| `qvac` | STT engine (auto prefers the resident worker) |
| `MEDPSY_TTS_ENGINE` | `kokoro` | `kokoro` \| `supertonic` | TTS engine (then falls back to the other) |
| `MEDPSY_TTS_VOICE` | `af_heart` | multilingual Kokoro voices (en/de/fr/es/it/zh/…) | default TTS voice |
| `MEDPSY_KOKORO_PY` | harness `.venv` python | path | Python interpreter that has `kokoro-onnx` |
| `MEDPSY_KOKORO_ONNX` / `_VOICES` | `models/kokoro-v1.0.onnx` / `voices-v1.0.bin` | path | Kokoro model + voices |
| `MEDPSY_PARAKEET_BIN` / `_LIB` / `MEDPSY_STT_GGUF` | `models/…` | path | parakeet-cli, libparakeet, Nemotron GGUF |
| `MEDPSY_SHERPA_PY` | kokoro venv python | path | Python with `sherpa-onnx` (Cantonese STT/TTS) |
| `MEDPSY_SENSEVOICE_DIR` / `MEDPSY_CANTO_TTS_DIR` | `models/…` | path | Cantonese SenseVoice / VITS model dirs |
