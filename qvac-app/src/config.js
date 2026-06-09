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
const MODELS = path.join(import.meta.dirname, "..", "models");
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
export const PARAKEET_LIB = process.env.MEDPSY_PARAKEET_LIB || path.join(MODELS, "libparakeet.dylib");
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
