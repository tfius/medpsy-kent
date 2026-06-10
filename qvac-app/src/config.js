// Backend-neutral config. The app talks to a "provider" (see backend.js) so the same
// triage + ICD-RAG logic runs against either LM Studio (dev, today) or the QVAC SDK
// (local-first, on-device). Switch with MEDPSY_BACKEND=lmstudio | qvac.

export const BACKEND = process.env.MEDPSY_BACKEND || "lmstudio";

// --- LM Studio (OpenAI-compatible) — works now with your running server ---
export const LMSTUDIO_URL = process.env.LMSTUDIO_URL || "http://localhost:1234";
export const LMSTUDIO_LLM = process.env.MEDPSY_LLM || "medpsy-4b";
export const LMSTUDIO_EMBED = process.env.MEDPSY_EMBED || "text-embedding-nomic-embed-text-v1.5";

// --- QVAC SDK — local .gguf (symlinked into ./models), else a registry constant ---
import path from "node:path";
import fs from "node:fs";
const ROOT = path.join(import.meta.dirname, "..");
const MODELS = path.join(ROOT, "models");
export const QVAC_LLM_GGUF = process.env.MEDPSY_GGUF || path.join(MODELS, "medpsy-4b.gguf");
export const QVAC_EMBED_GGUF = process.env.MEDPSY_EMBED_GGUF || null; // null -> registry embed model

// nomic-style prefixes help retrieval models separate corpus vs query.
export const DOC_PREFIX = "search_document: ";
export const QUERY_PREFIX = "search_query: ";

// medpsy is a reasoning model — give completions plenty of room to think then answer.
export const TEMPERATURE = 0.3;
export const MAX_TOKENS = 8192; // >=8k headroom for reasoning models

// --- On-device speech (QVAC SDK) ---
// STT: a parakeet-transcription GGUF. Point MEDPSY_STT_GGUF at the Nemotron-3.5-ASR
// GGUF (40+ langs, streaming) or parakeet-tdt-0.6b-v3; null -> a registry constant (English CTC).
export const STT_MODEL_SRC = process.env.MEDPSY_STT_GGUF || null;
export const TTS_MODEL_SRC = process.env.MEDPSY_TTS_GGUF || null; // Chatterbox by default
export const SPEECH_LANG = process.env.MEDPSY_SPEECH_LANG || "auto";

// --- STT engine selection ---
// "parakeet-cli" runs the local parakeet.cpp binary on Nemotron-3.5-ASR (truly
//   local, bypasses the @qvac native build — mirrors how Kokoro bypasses it for TTS).
// "qvac" uses the @qvac SDK transcribe (on-device, needs the native worker).
// "auto" picks parakeet-cli if its binary + GGUF are present, else qvac.
export const STT_ENGINE = process.env.MEDPSY_STT_ENGINE || "auto";
export const PARAKEET_BIN = process.env.MEDPSY_PARAKEET_BIN || path.join(MODELS, "parakeet-cli");
export const STT_GGUF = process.env.MEDPSY_STT_GGUF || path.join(MODELS, "nemotron-3.5-asr-streaming-0.6b-q8_0.gguf");
// "parakeet-server": a persistent Python worker keeps the model resident (fast,
// no per-request reload). Needs python3 + libparakeet.dylib + the GGUF.
// Shared-lib name is OS-specific: .dylib (macOS), .so (Linux), .dll (Windows).
const LIB_EXT = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
export const PARAKEET_LIB = process.env.MEDPSY_PARAKEET_LIB || path.join(MODELS, `libparakeet.${LIB_EXT}`);
export const STT_WORKER = path.join(import.meta.dirname, "..", "scripts", "stt_worker.py");

// --- TTS engine selection ---
// "kokoro"    -> Kokoro 82M ONNX via kokoro-js (on-device, Node-native, no @qvac/sdk
//                build needed; nice natural voice, ~real-time). Default.
// "supertonic"-> QVAC SDK Supertonic engine (the previous on-device path).
export const TTS_ENGINE = process.env.MEDPSY_TTS_ENGINE || "kokoro";
// kokoro-js pulls quantized ONNX from the HF hub on first use and caches it.
export const KOKORO_MODEL = process.env.MEDPSY_KOKORO_MODEL || "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_DTYPE = process.env.MEDPSY_KOKORO_DTYPE || "q8"; // fp32|fp16|q8|q4
export const KOKORO_VOICE = process.env.MEDPSY_TTS_VOICE || "af_heart";
// Multilingual TTS runs through a persistent Python kokoro-onnx worker (kokoro-js
// is English-only and mis-pronounces other languages). Needs python + kokoro-onnx
// + the Kokoro v1.0 ONNX model and voices .bin.
// Python interpreter for the speech workers (kokoro-onnx + sherpa-onnx). Resolution:
//   1. MEDPSY_KOKORO_PY (explicit override)
//   2. the currently-ACTIVATED venv (VIRTUAL_ENV) — `source <venv>/bin/activate` then npm
//   3. a repo-local venv: ./.venv or ./venv (create one and it's found with no config)
//   4. "python3" on PATH
// Cross-platform: venv python is bin/python (POSIX) or Scripts/python.exe (Windows).
function resolvePython() {
  if (process.env.MEDPSY_KOKORO_PY) return process.env.MEDPSY_KOKORO_PY;
  const rel = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  const candidates = [];
  if (process.env.VIRTUAL_ENV) candidates.push(path.join(process.env.VIRTUAL_ENV, ...rel));
  candidates.push(path.join(ROOT, ".venv", ...rel), path.join(ROOT, "venv", ...rel));
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return "python3";
}
export const KOKORO_PY = resolvePython();
export const KOKORO_ONNX = process.env.MEDPSY_KOKORO_ONNX || path.join(MODELS, "kokoro-v1.0.onnx");
export const KOKORO_VOICES_BIN = process.env.MEDPSY_KOKORO_VOICES || path.join(MODELS, "voices-v1.0.bin");
export const TTS_WORKER = path.join(import.meta.dirname, "..", "scripts", "tts_worker.py");

// --- Cantonese (yue) speech via sherpa-onnx (activates ONLY when lang/voice is yue) ---
// Nemotron has no Cantonese and Kokoro has no Cantonese voice, so Cantonese routes to
// dedicated sherpa-onnx models through persistent Python workers (same pattern as above):
//   STT: SenseVoice-Small (zh/en/ja/ko/yue) — model.int8.onnx + tokens.txt
//   TTS: vits-cantonese-hf-xiaomaiiwn (real Cantonese VITS) — onnx + lexicon + tokens
// Both run on the same venv as Kokoro (needs `sherpa-onnx`); missing models degrade
// gracefully (STT -> Nemotron, TTS -> Mandarin Kokoro voice).
export const SHERPA_PY = process.env.MEDPSY_SHERPA_PY || KOKORO_PY;
const SENSEVOICE_DIR = process.env.MEDPSY_SENSEVOICE_DIR
  || path.join(MODELS, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09");
export const SENSEVOICE_ONNX = process.env.MEDPSY_SENSEVOICE_ONNX || path.join(SENSEVOICE_DIR, "model.int8.onnx");
export const SENSEVOICE_TOKENS = process.env.MEDPSY_SENSEVOICE_TOKENS || path.join(SENSEVOICE_DIR, "tokens.txt");
export const SENSEVOICE_WORKER = path.join(import.meta.dirname, "..", "scripts", "sherpa_stt_worker.py");

const CANTO_TTS_DIR = process.env.MEDPSY_CANTO_TTS_DIR || path.join(MODELS, "vits-cantonese-hf-xiaomaiiwn");
export const CANTO_TTS_ONNX = process.env.MEDPSY_CANTO_ONNX || path.join(CANTO_TTS_DIR, "vits-cantonese-hf-xiaomaiiwn.onnx");
export const CANTO_TTS_LEXICON = process.env.MEDPSY_CANTO_LEXICON || path.join(CANTO_TTS_DIR, "lexicon.txt");
export const CANTO_TTS_TOKENS = process.env.MEDPSY_CANTO_TOKENS || path.join(CANTO_TTS_DIR, "tokens.txt");
export const CANTO_TTS_RULE = process.env.MEDPSY_CANTO_RULE || path.join(CANTO_TTS_DIR, "rule.fst");
export const CANTO_TTS_WORKER = path.join(import.meta.dirname, "..", "scripts", "sherpa_tts_worker.py");
// The voice id the kiosk uses to request Cantonese TTS (routes to the VITS worker).
export const CANTO_VOICE_ID = "yue_canto";
