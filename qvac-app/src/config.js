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
