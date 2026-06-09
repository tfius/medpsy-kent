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
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  STT_MODEL_SRC, SPEECH_LANG, STT_ENGINE, PARAKEET_BIN, STT_GGUF, PARAKEET_LIB, STT_WORKER,
  TTS_ENGINE, KOKORO_MODEL, KOKORO_DTYPE, KOKORO_VOICE,
} from "./config.js";

const execFileP = promisify(execFile);

let sdk = null, sttId = null, ttsId = null, kokoro = null;
const getSdk = async () => (sdk ??= await import("@qvac/sdk"));

// ---- STT (Parakeet / Nemotron-3.5-ASR) ----
export async function loadSTT(onProgress) {
  const s = await getSdk();
  const src = STT_MODEL_SRC || s.PARAKEET_CTC_0_6B_Q8_0; // override env for Nemotron/parakeet-v3 GGUF
  sttId = await s.loadModel({ modelSrc: src, modelType: "parakeet-transcription", onProgress });
  return sttId;
}

// --- STT engine: persistent parakeet.cpp worker (model stays resident) ---
// A long-lived python3 process loads Nemotron once and transcribes WAV paths fed
// over stdin (see scripts/stt_worker.py). Requests are serialized FIFO.
let sttWorker = null;
function getSttWorker() {
  if (sttWorker) return sttWorker;
  const proc = spawn("python3", [STT_WORKER], {
    env: { ...process.env, MEDPSY_PARAKEET_LIB: PARAKEET_LIB, MEDPSY_STT_GGUF: STT_GGUF, MEDPSY_SPEECH_LANG: SPEECH_LANG },
    stdio: ["pipe", "pipe", "inherit"], // ggml/Metal logs -> server console (stderr)
  });
  const w = { proc, queue: [], buf: "", ready: false, readyWaiters: [] };
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    w.buf += chunk;
    let i;
    while ((i = w.buf.indexOf("\n")) >= 0) {
      const line = w.buf.slice(0, i); w.buf = w.buf.slice(i + 1);
      if (line.startsWith("@@READY@@")) {
        w.ready = true; w.readyWaiters.forEach((r) => r()); w.readyWaiters = [];
      } else if (line.startsWith("@@STT@@")) {
        const job = w.queue.shift();
        if (job) {
          try { const o = JSON.parse(line.slice("@@STT@@".length).trim());
            o.error ? job.reject(new Error(o.error)) : job.resolve(o.text || ""); }
          catch (e) { job.reject(e); }
        }
      } // any other stdout line is ignored
    }
  });
  const fail = (err) => {
    if (sttWorker === w) sttWorker = null;
    w.queue.forEach((j) => j.reject(err)); w.queue = [];
    w.readyWaiters.forEach((r) => r(err)); w.readyWaiters = [];
  };
  proc.on("exit", (code) => fail(new Error(`stt worker exited (code ${code})`)));
  proc.on("error", (e) => fail(e));
  sttWorker = w;
  return w;
}

function transcribeParakeetServer(wavPath) {
  const w = getSttWorker();
  return new Promise((resolve, reject) => {
    const send = () => { w.queue.push({ resolve, reject }); w.proc.stdin.write(wavPath + "\n"); };
    if (w.ready) send();
    else w.readyWaiters.push((err) => (err ? reject(err) : send()));
  });
}

// Local Nemotron-3.5-ASR via the parakeet.cpp CLI (reloads the model each call —
// the fallback when the persistent worker isn't available). Strips inline <lang> tags.
async function transcribeParakeetCli(wavPath) {
  const { stdout } = await execFileP(
    PARAKEET_BIN,
    ["transcribe", "--model", STT_GGUF, "--input", wavPath, "--lang", SPEECH_LANG],
    { maxBuffer: 16 * 1024 * 1024 }, // stdout is just the transcript; ggml logs go to stderr
  );
  return stdout.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function transcribeQvac(audioChunk) {
  const s = await getSdk();
  if (!sttId) await loadSTT();
  return s.transcribe({ modelId: sttId, audioChunk, lang: SPEECH_LANG });
}

const STT_BACKENDS = {
  "parakeet-server": transcribeParakeetServer,
  "parakeet-cli": transcribeParakeetCli,
  "qvac": transcribeQvac,
};

// Preferred engine first, then fallbacks. "auto" prefers the persistent worker.
function sttOrder() {
  if (STT_ENGINE !== "auto") return [STT_ENGINE];
  const order = [];
  const haveModel = fs.existsSync(STT_GGUF);
  if (haveModel && fs.existsSync(PARAKEET_LIB)) order.push("parakeet-server");
  if (haveModel && fs.existsSync(PARAKEET_BIN)) order.push("parakeet-cli");
  order.push("qvac");
  return order;
}

// Spawn + warm the persistent STT worker ahead of the first request (call at
// server start so the model is loaded before anyone speaks). Best-effort.
export function prewarmStt() {
  if (sttOrder()[0] === "parakeet-server") {
    try { getSttWorker(); } catch { /* falls back at request time */ }
  }
}

// audioChunk: a WAV file path (16 kHz mono PCM). Returns the transcript text.
// Tries the preferred engine, falling back through the chain on failure.
export async function transcribe(audioChunk) {
  let lastErr;
  for (const engine of sttOrder()) {
    try {
      return await STT_BACKENDS[engine](audioChunk);
    } catch (e) {
      lastErr = e;
      console.warn(`[stt] ${engine} failed (${e?.message || e}); trying next engine`);
    }
  }
  throw new Error(`all STT engines failed: ${lastErr?.message || lastErr}`);
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
