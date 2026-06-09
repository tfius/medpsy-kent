// On-device STT + TTS (no cloud).
//   STT: QVAC parakeet-transcription engine — Parakeet/Nemotron-3.5-ASR GGUF (transcribe).
//   TTS: Kokoro by default, with a fallback chain (MEDPSY_TTS_ENGINE picks the primary):
//        "kokoro"     -> Kokoro 82M ONNX via kokoro-js (Node-native, no @qvac/sdk build,
//                        nice natural voice, ~real-time). Default.
//        "supertonic" -> QVAC SDK Supertonic ONNX engine (textToSpeech), 44.1 kHz.
//        If the primary engine fails to load/synthesize, we fall back to the next one.
// @qvac/sdk and kokoro-js are imported lazily so each path only loads what it uses
// (the LM-Studio dev path can do Kokoro TTS with no native QVAC build).
// Verified against QVAC examples (packages/sdk/examples/{transcription,tts}).
//
// CLI:  node src/speech.js tts "hello there" out.wav
//       node src/speech.js stt clip.wav            # 16 kHz mono WAV
import fs from "node:fs";
import {
  STT_MODEL_SRC, SPEECH_LANG,
  TTS_ENGINE, KOKORO_MODEL, KOKORO_DTYPE, KOKORO_VOICE,
} from "./config.js";

let sdk = null, sttId = null, ttsId = null, kokoro = null;
const getSdk = async () => (sdk ??= await import("@qvac/sdk"));

// ---- STT (Parakeet / Nemotron-3.5-ASR) ----
export async function loadSTT(onProgress) {
  const s = await getSdk();
  const src = STT_MODEL_SRC || s.PARAKEET_CTC_0_6B_Q8_0; // override env for Nemotron/parakeet-v3 GGUF
  sttId = await s.loadModel({ modelSrc: src, modelType: "parakeet-transcription", onProgress });
  return sttId;
}

// audioChunk: a WAV file path (16 kHz mono PCM). Returns the transcript text.
export async function transcribe(audioChunk) {
  const s = await getSdk();
  if (!sttId) await loadSTT();
  return s.transcribe({ modelId: sttId, audioChunk, lang: SPEECH_LANG });
}

// ---- TTS (Supertonic — general-purpose, no voice cloning, 44.1 kHz) ----
// Supertonic is a multi-component ONNX pipeline (text encoder + duration predictor +
// vector estimator + vocoder). Higher quality and self-contained vs. Chatterbox, which
// is a voice-cloning engine that requires a reference-audio WAV. All component models
// download from the QVAC Registry on first load and are cached.
export const TTS_SAMPLE_RATE = 44100;
export async function loadTTS(onProgress) {
  const s = await getSdk();
  ttsId = await s.loadModel({
    modelSrc: s.TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32.src,
    modelType: "tts",
    modelConfig: {
      ttsEngine: "supertonic",
      language: "en",
      ttsSpeed: 1.0,
      ttsNumInferenceSteps: 5,
      ttsSupertonicMultilingual: true,
      ttsTextEncoderSrc: s.TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32.src,
      ttsDurationPredictorSrc: s.TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32.src,
      ttsVectorEstimatorSrc: s.TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32.src,
      ttsVocoderSrc: s.TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32.src,
      ttsUnicodeIndexerSrc: s.TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32.src,
      ttsTtsConfigSrc: s.TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE.src,
      ttsVoiceStyleSrc: s.TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE.src,
    },
    onProgress,
  });
  return ttsId;
}

// Supertonic synthesis -> WAV (16-bit mono @44.1 kHz) Buffer. (Single voice; the
// `voice` option only applies to Kokoro.)
async function synthesizeWavSupertonic(text /*, opts */) {
  const s = await getSdk();
  if (!ttsId) await loadTTS();
  const result = s.textToSpeech({ modelId: ttsId, text, inputType: "text", stream: false });
  const pcm = await result.buffer; // Int16 PCM samples
  return pcmToWav(pcm, TTS_SAMPLE_RATE);
}

// ---- TTS (Kokoro — kokoro-js, on-device ONNX, no @qvac/sdk build) ----
// 82M model + voices download from the HF hub on first load and are cached by
// transformers.js. `generate` returns a RawAudio whose toWav() gives a full WAV.
async function loadKokoro(onProgress) {
  const { KokoroTTS } = await import("kokoro-js");
  kokoro ??= await KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: KOKORO_DTYPE,          // q8 = small + fast, good quality
    device: "cpu",               // onnxruntime-node; kiosk-friendly
    progress_callback: onProgress,
  });
  return kokoro;
}

async function synthesizeWavKokoro(text, { voice } = {}) {
  const tts = await loadKokoro();
  const audio = await tts.generate(text, { voice: voice || KOKORO_VOICE });
  // audio.audio is Float32 in [-1,1]; emit 16-bit PCM WAV like the Supertonic
  // path (format tag 1) for consistent, broadly-compatible output.
  const f32 = audio.audio;
  const pcm16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcmToWav(Buffer.from(pcm16.buffer), audio.sampling_rate);
}

// Engine -> synth fn. synthesizeWav tries the configured engine first, then the
// rest as fallbacks, so a missing/broken engine degrades instead of erroring.
const TTS_BACKENDS = {
  kokoro: synthesizeWavKokoro,
  supertonic: synthesizeWavSupertonic,
};

// Returns a complete WAV Buffer for `text`. Tries TTS_ENGINE, then falls back.
// opts.voice selects a Kokoro voice (ignored by Supertonic).
export async function synthesizeWav(text, opts = {}) {
  const order = [TTS_ENGINE, ...Object.keys(TTS_BACKENDS).filter((e) => e !== TTS_ENGINE)];
  let lastErr;
  for (const engine of order) {
    const fn = TTS_BACKENDS[engine];
    if (!fn) continue;
    try {
      return await fn(text, opts);
    } catch (e) {
      lastErr = e;
      console.warn(`[tts] ${engine} failed (${e?.message || e}); trying next engine`);
    }
  }
  throw new Error(`all TTS engines failed: ${lastErr?.message || lastErr}`);
}

// List selectable Kokoro voices: [{ id, name, language, gender, grade }, ...].
// Returns [] if Kokoro isn't the active engine or fails to load.
export async function listVoices() {
  if (TTS_ENGINE !== "kokoro") return [];
  try {
    const tts = await loadKokoro();
    return Object.entries(tts.voices || {}).map(([id, v]) => ({
      id, name: v?.name, language: v?.language, gender: v?.gender,
      grade: v?.overallGrade,
    }));
  } catch (e) {
    console.warn(`[tts] listVoices failed (${e?.message || e})`);
    return [];
  }
}

function pcmToWav(pcm, rate) {
  const data = Buffer.isBuffer(pcm)
    ? pcm
    : Buffer.from(pcm.buffer ?? pcm, pcm.byteOffset ?? 0, pcm.byteLength ?? pcm.length * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg, out] = process.argv.slice(2);
  if (cmd === "tts" && arg) {
    const wav = await synthesizeWav(arg);
    fs.writeFileSync(out || "tts-output.wav", wav);
    console.log(`wrote ${out || "tts-output.wav"} (${wav.length} bytes)`);
  } else if (cmd === "stt" && arg) {
    console.log(await transcribe(arg));
  } else {
    console.error('usage: node src/speech.js tts "<text>" [out.wav] | stt <clip.wav>');
    process.exit(1);
  }
}
