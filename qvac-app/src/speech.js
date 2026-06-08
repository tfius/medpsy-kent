// On-device STT + TTS via the QVAC SDK (no cloud).
//   STT: parakeet-transcription engine — Parakeet/Nemotron-3.5-ASR GGUF (transcribe).
//   TTS: Chatterbox GGML engine (textToSpeech).
// @qvac/sdk is imported lazily so the rest of the app (LM Studio path) needs no native build.
// Verified against QVAC examples (packages/sdk/examples/{transcription,tts}).
//
// CLI:  node src/speech.js tts "hello there" out.wav
//       node src/speech.js stt clip.wav            # 16 kHz mono WAV
import fs from "node:fs";
import { STT_MODEL_SRC, TTS_MODEL_SRC, SPEECH_LANG } from "./config.js";

let sdk = null, sttId = null, ttsId = null;
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

// ---- TTS (Chatterbox) ----
export async function loadTTS(onProgress) {
  const s = await getSdk();
  ttsId = await s.loadModel({
    modelSrc: TTS_MODEL_SRC || s.TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
    modelConfig: { ttsEngine: "chatterbox", language: "en", s3genModelSrc: s.TTS_S3GEN_EN_CHATTERBOX?.src },
    onProgress,
  });
  return ttsId;
}

// Returns a complete WAV (16-bit mono @24 kHz) Buffer for `text`.
export async function synthesizeWav(text) {
  const s = await getSdk();
  if (!ttsId) await loadTTS();
  const result = s.textToSpeech({ modelId: ttsId, text, inputType: "text", stream: false });
  const pcm = await result.buffer; // Int16 PCM samples
  return pcmToWav(pcm, 24000);
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
