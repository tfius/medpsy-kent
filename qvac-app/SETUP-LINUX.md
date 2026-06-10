# Setup guide (Linux) — getting the speech stack running

This walks through the three things people get stuck on: the **Python venv** (kokoro-onnx
+ sherpa-onnx), **building parakeet.cpp**, and pointing the app at both. Commands assume
Ubuntu/Kubuntu; adapt the package manager elsewhere.

> TL;DR of the venv problem: the app used to hard-code one developer's macOS Python path,
> so `npm run check` looked at the wrong interpreter and never saw your venv. It now
> auto-detects (1) an **activated** venv, (2) a repo-local `./.venv` or `./venv`, or (3)
> `python3`. So: **activate your venv, then run npm** — or set `MEDPSY_KOKORO_PY`.

---

## 0. Prerequisites

```bash
sudo apt update
sudo apt install -y build-essential cmake git python3 python3-venv nodejs npm
```

Then install JS deps:

```bash
cd ~/projects/hackthon/medpsy-kent/qvac-app
npm install
```

---

## 1. Python venv (fixes "preflight does not see kokoro-onnx / sherpa-onnx")

Your venv is fine — the app just has to use *its* Python. Pick **one** of these:

**Option A (simplest): name it `.venv` inside the app dir.** The app finds it with zero config.
```bash
cd ~/projects/hackthon/medpsy-kent/qvac-app
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install kokoro-onnx sherpa-onnx numpy
```

**Option B: keep your existing `kokoro` venv** — just activate it before running npm, or
point the app at it explicitly:
```bash
source /path/to/kokoro/bin/activate        # you're already in (kokoro)
export MEDPSY_KOKORO_PY="$(which python)"   # belt-and-suspenders; also covers sherpa
```
> `MEDPSY_KOKORO_PY` sets the interpreter for **both** kokoro-onnx and sherpa-onnx
> (sherpa defaults to the same Python). Override sherpa separately with `MEDPSY_SHERPA_PY`
> if you ever split them.

Verify the interpreter has both libraries:
```bash
python -c "import kokoro_onnx, sherpa_onnx; print('kokoro + sherpa OK')"
```

Now `npm run check` should show green for "python with kokoro-onnx" and "python with
sherpa-onnx". (Run it from the app dir, with the venv active.)

---

## 2. Build parakeet.cpp (the Nemotron STT engine)

This is the English/European speech-to-text engine. It's a C++/ggml project — build the
**shared library + CLI**, which is what the app loads.

```bash
git clone --recursive https://github.com/mudler/parakeet.cpp
cd parakeet.cpp
# --recursive matters: ggml is a vendored submodule. If you forgot it:
#   git submodule update --init --recursive

cmake -B build-shared -DPARAKEET_SHARED=ON -DPARAKEET_BUILD_CLI=ON -DGGML_NATIVE=OFF
cmake --build build-shared -j

# Produces:
#   build-shared/libparakeet.so
#   build-shared/examples/cli/parakeet-cli
```

- `-DPARAKEET_SHARED=ON` → builds `libparakeet.so` (the persistent worker dlopen's it).
- `-DPARAKEET_BUILD_CLI=ON` → builds `parakeet-cli` (the per-request fallback).
- `-DGGML_NATIVE=OFF` → portable build (safe on any CPU). Drop it for a slightly faster
  host-tuned build.
- **GPU (optional):** add `-DPARAKEET_GGML_CUDA=ON` (NVIDIA), `-DPARAKEET_GGML_HIP=ON`
  (AMD/ROCm), or `-DPARAKEET_GGML_VULKAN=ON`. CPU is fine for the 0.6B model.

### Point the app at the build

The app looks for `models/libparakeet.so` + `models/parakeet-cli` (Linux name resolved
automatically). Symlink them:

```bash
cd ~/projects/hackthon/medpsy-kent/qvac-app/models
ln -sf /abs/path/to/parakeet.cpp/build-shared/libparakeet.so libparakeet.so
ln -sf /abs/path/to/parakeet.cpp/build-shared/examples/cli/parakeet-cli parakeet-cli
```
…or skip the symlinks and set env vars instead:
```bash
export MEDPSY_PARAKEET_LIB=/abs/path/to/parakeet.cpp/build-shared/libparakeet.so
export MEDPSY_PARAKEET_BIN=/abs/path/to/parakeet.cpp/build-shared/examples/cli/parakeet-cli
```

> **Don't need English STT?** parakeet.cpp is the only part that must be compiled. If your
> demo is Cantonese (SenseVoice) or TTS-only, you can skip it — the kiosk degrades
> gracefully (English dictation just won't work until it's built).

---

## 3. Download the models

```bash
npm run download-models
```
Fetches (into `models/`): the **Nemotron GGUF** (~940 MB, English STT), **Kokoro** ONNX +
voices (TTS), and the optional **Cantonese** sherpa-onnx archives (SenseVoice STT ~230 MB
+ Cantonese VITS TTS ~112 MB). Already-present files are skipped.

---

## 4. Verify + run

```bash
npm run check          # all rows should be ✓ (Cantonese rows are optional)
npm run start          # preflight → API server (:8787) → web kiosk (Vite)
```
- **LM Studio** must be running separately on `:1234` with **medpsy-4b** + an embedding
  model loaded (that part isn't downloadable here — set it up in LM Studio).
- The kiosk opens on the first free Vite port (5173 if nothing else uses it).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `check` says python-with-kokoro/sherpa missing | venv not active **and** not at `./.venv`. Activate it, or `export MEDPSY_KOKORO_PY=$(which python)`. |
| All read-aloud sounds robotic / "basic" | `/api/tts` isn't reaching `:8787` (server not running, or the browser tab is on a different project's port). Confirm `curl localhost:8787/api/health` → `{"ok":true}` and use the kiosk URL Vite prints. |
| `libparakeet` not found | wrong path/extension. On Linux it's `.so` (not `.dylib`). Re-check the symlink or `MEDPSY_PARAKEET_LIB`. |
| `cmake` can't find ggml | you cloned without `--recursive`; run `git submodule update --init --recursive`. |
| STT for English does nothing | parakeet.cpp not built yet (section 2), or no Nemotron GGUF (`npm run download-models`). |
| sherpa-onnx install fails | use a recent pip (`pip install --upgrade pip`); sherpa-onnx ships manylinux wheels for x86_64/arm64. |

## Environment variables (all optional — defaults work once the venv + build are in place)

| Var | What it points at |
|---|---|
| `MEDPSY_KOKORO_PY` | Python interpreter with kokoro-onnx **and** sherpa-onnx (covers both) |
| `MEDPSY_SHERPA_PY` | override just the sherpa (Cantonese) interpreter |
| `MEDPSY_PARAKEET_LIB` / `MEDPSY_PARAKEET_BIN` | `libparakeet.so` / `parakeet-cli` paths |
| `MEDPSY_STT_GGUF` | Nemotron GGUF path |
| `API_PORT` | Node API port (default 8787) |
| `LMSTUDIO_URL` | LM Studio base URL (default `http://localhost:1234`) |
