# CLAUDE.md — working in this repo

## What this repo is
Two related things:
1. **medpsy-eval** (repo root, Python) — a harness that evaluates **medpsy**, a small locally-served
   medical model, as a pharmacist triage / decision-support tool. Runs question banks against an
   LM Studio endpoint, grades with Claude, and grounds ICD-10 codes. See `README.md`, `EVALUATION.md`,
   `JOURNAL.md` / `JOURNAL_ELI5.md` (running logs — newest at bottom; keep both in sync when asked).
2. **`qvac-app/`** (Node + React) — the productized **kiosk**: a local-first, multilingual, voice-enabled
   9-step triage flow built for the QVAC SDK. **This is the active dev focus.** See `qvac-app/README.md`
   and `qvac-app/ARCHITECTURE.md`.

A **sibling repo** `../nemotron-asr-test` (outside this repo) is a throwaway harness that built the
on-device speech engines; the kiosk currently borrows its binaries/models/venv (see coupling below).

## Running the kiosk (`qvac-app/`)
**One command:** `cd qvac-app && npm run start` (preflight → API → web). `npm run check` reports
model/dependency availability + sizes + how to get what's missing; `npm run download-models` fetches
the downloadable models (Nemotron GGUF, Kokoro — the parakeet.cpp engine must be built, not downloaded).

Under the hood, three processes:
- **LM Studio** on `:1234` — load `medpsy-4b` + `text-embedding-nomic-embed-text-v1.5`, enable the server.
- **API server**: `cd qvac-app && npm run serve` → `:8787` (ICD grounding `/api/icd`, `/api/tts`, `/api/stt`;
  pre-warms the STT + TTS models — first start takes ~10-15 s).
- **Web kiosk**: `cd qvac-app/web && npm run dev` → Vite picks a free port; it proxies `/v1`→LM Studio,
  `/api`→`:8787`.

⚠️ **Port gotcha:** on this machine `:5173` and `:5174` are *other* projects (skatle, cybersecurity).
medpsy's web server is usually on **`:5175`** — confirm via the `<title>MedPsy Triage</title>`.

## Models & on-device speech
- **LLM:** medpsy-4b (triage, SBAR, embeddings) via LM Studio, or the QVAC SDK (`MEDPSY_BACKEND=qvac`).
- **STT:** Nemotron-3.5-ASR (40 locales) via **parakeet.cpp** — persistent Python worker
  (`scripts/stt_worker.py`, ctypes → `libparakeet.dylib`, model resident → ~0.13 s). Web records mic →
  16 kHz mono WAV → `/api/stt`. No cloud Web Speech API.
- **TTS:** Kokoro-82M v1.0 (multilingual) via **`kokoro-onnx`** — persistent Python worker
  (`scripts/tts_worker.py`). Synthesizes with the correct language per voice id.
  **Do not use kokoro-js** — it is English-only (mis-reads other languages); it was replaced.
- **i18n:** 8 UI languages; full translations live in `web/src/lib/i18n/*.json` (one file per lang,
  keys parity-checked). `web/src/lib/prefs.tsx` holds `LANG_SUPPORT` (per-language STT/TTS reality).

### ⚠️ Dev coupling (fragile, env-overridable)
STT/TTS reference the sibling harness via symlinks in `qvac-app/models/` (gitignored) and the harness
Python venv:
`models/{parakeet-cli,libparakeet.dylib,nemotron-…gguf,kokoro-v1.0.onnx,voices-v1.0.bin}` →
`../nemotron-asr-test/…`; TTS worker python → `../nemotron-asr-test/.venv/bin/python` (has `kokoro-onnx`).
Override with `MEDPSY_PARAKEET_BIN/_LIB/_STT_GGUF`, `MEDPSY_KOKORO_PY/_ONNX/_VOICES`. There's a known
ggml-metal teardown assert on worker shutdown — handled by `os._exit()` in the workers.

## Conventions
- **Verify web changes** with `cd qvac-app/web && npx tsc --noEmit && npm run build` (HMR applies live;
  the headless browser screenshot tools time out on localhost vite — don't rabbit-hole on them).
- **Restart `npm run serve`** after editing `src/*.js` (no hot reload) to pick up server/speech changes.
- **Commit/push only when asked.** End commit messages with the Co-Authored-By trailer.
- **Journaling:** when asked, add to `JOURNAL.md` (technical, newest at bottom) and/or `JOURNAL_ELI5.md`
  (plain-language; insert before its "three sentences" closer).
- Patient-facing UI text goes through `useT()` / the i18n JSON; dev annotations (MOCK badges, system
  prompts, X12/SHA labels) stay English.
