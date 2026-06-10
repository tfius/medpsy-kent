#!/usr/bin/env node
// Preflight: check every model + dependency the kiosk needs, report what's present,
// what's missing (with sizes + how to get it). `--download` fetches the model files
// that can be downloaded (the Nemotron GGUF + Kokoro). The parakeet.cpp engine must be
// BUILT (see ../../nemotron-asr-test) and LM Studio set up by you.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import {
  STT_GGUF, PARAKEET_BIN, PARAKEET_LIB, KOKORO_ONNX, KOKORO_VOICES_BIN, KOKORO_PY,
  LMSTUDIO_URL, LMSTUDIO_LLM, QVAC_LLM_GGUF, QVAC_EMBED_GGUF,
  SHERPA_PY, SENSEVOICE_ONNX, CANTO_TTS_ONNX,
} from "../src/config.js";

const ROOT = path.join(import.meta.dirname, "..");
const MODELS = path.join(ROOT, "models");
const DL = process.argv.includes("--download");
const c = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ex = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
const mb = (p) => { try { return `${(fs.statSync(p).size / 1e6).toFixed(0)} MB`; } catch { return "?"; } };

const DOWNLOADS = [
  { label: "Nemotron-3.5-ASR GGUF (STT model)", dest: STT_GGUF, size: "~940 MB",
    url: "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/main/nemotron-3.5-asr-streaming-0.6b-q8_0.gguf?download=true" },
  { label: "nomic-embed-text-v1.5 GGUF (QVAC embeddings, 768-d)", dest: QVAC_EMBED_GGUF, size: "~146 MB",
    url: "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf?download=true" },
  { label: "Kokoro v1.0 ONNX (TTS model)", dest: KOKORO_ONNX, size: "~310 MB",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx" },
  { label: "Kokoro voices (TTS)", dest: KOKORO_VOICES_BIN, size: "~27 MB",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin" },
  // Cantonese (optional) — tar.bz2 archives extracted into models/.
  { label: "SenseVoice STT — Cantonese +zh/en/ja/ko (optional)", archive: true, check: SENSEVOICE_ONNX, size: "~230 MB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2" },
  { label: "Cantonese VITS TTS (optional)", archive: true, check: CANTO_TTS_ONNX, size: "~112 MB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-cantonese-hf-xiaomaiiwn.tar.bz2" },
];

async function lmStudioOk() {
  try {
    const ctl = AbortSignal.timeout(3000);
    const r = await fetch(`${LMSTUDIO_URL}/v1/models`, { signal: ctl });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    const ids = (await r.json()).data?.map((m) => m.id) || [];
    const has = ids.some((i) => i.includes("medpsy"));
    return { ok: has, detail: has ? `${LMSTUDIO_LLM} available` : `reachable but no medpsy model loaded (have: ${ids.slice(0, 3).join(", ")}…)` };
  } catch { return { ok: false, detail: `not reachable at ${LMSTUDIO_URL}` }; }
}

const pyImports = (py, mod) => { try { return spawnSync(py, ["-c", `import ${mod}`], { timeout: 15000 }).status === 0; } catch { return false; } };

function row(ok, label, detail, fix) {
  const mark = ok ? `${c.g}✓${c.x}` : `${c.r}✗${c.x}`;
  console.log(`  ${mark} ${label}${detail ? `  ${c.d}${detail}${c.x}` : ""}`);
  if (!ok && fix) console.log(`      ${c.y}→ ${fix}${c.x}`);
  return ok;
}

function download(d) {
  if (d.archive) { // tar.bz2 -> extract into models/
    fs.mkdirSync(MODELS, { recursive: true });
    const tmp = path.join(os.tmpdir(), path.basename(d.url));
    console.log(`\n${c.b}↓ ${d.label}${c.x} (${d.size}) → ${path.relative(ROOT, d.check)}`);
    execFileSync("curl", ["-L", "--fail", "--progress-bar", "-o", tmp, d.url], { stdio: "inherit" });
    execFileSync("tar", ["-xjf", tmp, "-C", MODELS], { stdio: "inherit" });
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return;
  }
  try { if (fs.lstatSync(d.dest).isSymbolicLink()) fs.unlinkSync(d.dest); } catch { /* not a symlink */ }
  fs.mkdirSync(path.dirname(d.dest), { recursive: true });
  console.log(`\n${c.b}↓ ${d.label}${c.x} (${d.size}) → ${path.relative(ROOT, d.dest)}`);
  execFileSync("curl", ["-L", "--fail", "--progress-bar", "-o", d.dest, d.url], { stdio: "inherit" });
}

async function main() {
  console.log(`\n${c.b}medpsy kiosk — preflight${c.x}\n`);

  if (DL) {
    for (const d of DOWNLOADS) {
      const dest = d.check || d.dest;
      if (ex(dest)) console.log(`  ${c.g}✓${c.x} ${d.label} already present (${mb(dest)})`);
      else download(d);
    }
    console.log(`\n${c.d}download done — re-run without --download to verify.${c.x}\n`);
    return;
  }

  let ok = true;
  console.log(`${c.b}LLM${c.x} — medpsy via LM Studio (or QVAC SDK)`);
  const lm = await lmStudioOk();
  ok &= row(lm.ok, "LM Studio", lm.detail, "start LM Studio, load medpsy-4b + nomic-embed, enable server on :1234");

  console.log(`\n${c.b}QVAC on-device backend${c.x} ${c.d}(optional; MEDPSY_BACKEND=qvac — no LM Studio, no P2P)${c.x}`);
  const qLlm = ex(QVAC_LLM_GGUF), qEmb = ex(QVAC_EMBED_GGUF);
  row(qLlm, "medpsy LLM gguf (local)", qLlm ? mb(QVAC_LLM_GGUF) : "symlink models/medpsy-4b.gguf", "point MEDPSY_GGUF at a local medpsy gguf");
  row(qEmb, "nomic embeddings gguf (local, 768-d)", qEmb ? mb(QVAC_EMBED_GGUF) : "~146 MB", "npm run download-models");

  console.log(`\n${c.b}ICD-10 grounding${c.x}`);
  const idx = path.join(ROOT, "data", "icd10.index.bin");
  ok &= row(ex(idx), "vector index", ex(idx) ? mb(idx) : undefined, "npm run build-icd-index");

  console.log(`\n${c.b}STT${c.x} — Nemotron-3.5-ASR via parakeet.cpp`);
  const sttModel = ex(STT_GGUF), sttLib = ex(PARAKEET_LIB), sttBin = ex(PARAKEET_BIN), sttPy = pyImports("python3", "ctypes");
  ok &= row(sttModel, "Nemotron GGUF", sttModel ? mb(STT_GGUF) : "~940 MB", "npm run download-models");
  ok &= row(sttLib && sttBin, "parakeet.cpp build (libparakeet.dylib + cli)", undefined,
    "build it in ../nemotron-asr-test (cmake), then symlink into models/  — cannot be downloaded");
  ok &= row(sttPy, "python3 (stdlib ctypes)", undefined, "install Python 3");

  console.log(`\n${c.b}TTS${c.x} — Kokoro v1.0 via kokoro-onnx (multilingual)`);
  const ttsOnnx = ex(KOKORO_ONNX), ttsVoices = ex(KOKORO_VOICES_BIN), ttsPy = pyImports(KOKORO_PY, "kokoro_onnx");
  ok &= row(ttsOnnx, "Kokoro ONNX", ttsOnnx ? mb(KOKORO_ONNX) : "~310 MB", "npm run download-models");
  ok &= row(ttsVoices, "Kokoro voices", ttsVoices ? mb(KOKORO_VOICES_BIN) : "~27 MB", "npm run download-models");
  ok &= row(ttsPy, `python with kokoro-onnx (${path.basename(KOKORO_PY)})`, undefined,
    `pip install kokoro-onnx  (or set MEDPSY_KOKORO_PY to a venv that has it)`);

  console.log(`\n${c.b}Cantonese (yue) — sherpa-onnx${c.x} ${c.d}(optional; only used when language = Cantonese)${c.x}`);
  const svOk = ex(SENSEVOICE_ONNX), cantoOk = ex(CANTO_TTS_ONNX), sherpaPy = pyImports(SHERPA_PY, "sherpa_onnx");
  row(svOk, "SenseVoice STT model", svOk ? mb(SENSEVOICE_ONNX) : "~230 MB", "npm run download-models");
  row(cantoOk, "Cantonese VITS TTS model", cantoOk ? mb(CANTO_TTS_ONNX) : "~112 MB", "npm run download-models");
  row(sherpaPy, `python with sherpa-onnx (${path.basename(SHERPA_PY)})`, undefined,
    "uv pip install --python <kokoro venv> sherpa-onnx  (or set MEDPSY_SHERPA_PY)");

  console.log(`\n${ok ? `${c.g}${c.b}✓ all ready${c.x} — npm run start` : `${c.y}${c.b}⚠ some pieces missing${c.x} (kiosk still runs; those features degrade)`}\n`);
  process.exit(ok ? 0 : 1);
}

main();
