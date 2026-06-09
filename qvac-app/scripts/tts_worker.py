#!/usr/bin/env python3
"""Persistent multilingual TTS worker for the medpsy kiosk.

Loads Kokoro-82M (v1.0, multilingual) ONCE via kokoro-onnx and synthesizes speech
with the CORRECT language per request — kokoro-js (the Node package) is English-only
and mis-pronounces other languages, so the server routes TTS here instead.

Protocol:
  stdin:  one JSON request per line: {"text": "...", "voice": "ff_siwis", "lang": "fr-fr"}
  stdout: "@@READY@@" once the model is loaded + warmed
          "@@TTS@@ {\"wav\": \"/tmp/...wav\"}"  path to a 16-bit mono WAV per request
          "@@TTS@@ {\"error\": \"...\"}"        on failure
Env: MEDPSY_KOKORO_ONNX (model .onnx), MEDPSY_KOKORO_VOICES (voices .bin).
"""
import json
import os
import signal
import struct
import sys
import tempfile

signal.signal(signal.SIGTERM, lambda *_: os._exit(0))

ONNX = os.environ.get("MEDPSY_KOKORO_ONNX")
VOICES = os.environ.get("MEDPSY_KOKORO_VOICES")


def log(msg: str) -> None:
    sys.stderr.write(f"[tts_worker] {msg}\n"); sys.stderr.flush()


def write_wav(path: str, samples, rate: int) -> None:
    import numpy as np
    pcm = np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0)
    data = (pcm * 32767.0).astype("<i2").tobytes()
    with open(path, "wb") as f:
        f.write(b"RIFF"); f.write(struct.pack("<I", 36 + len(data))); f.write(b"WAVE")
        f.write(b"fmt "); f.write(struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16))
        f.write(b"data"); f.write(struct.pack("<I", len(data))); f.write(data)


def main() -> None:
    if not ONNX or not os.path.exists(ONNX):
        log(f"model not found: {ONNX}"); sys.exit(2)
    from kokoro_onnx import Kokoro
    log(f"loading {ONNX} ...")
    k = Kokoro(ONNX, VOICES)
    try:
        k.create("Hello.", voice="af_heart", lang="en-us")  # warm
        log("warmed up")
    except Exception as e:  # noqa: BLE001
        log(f"warm-up skipped ({e})")

    sys.stdout.write("@@READY@@\n"); sys.stdout.flush()
    tmp = tempfile.gettempdir()
    n = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = req.get("text", "")
            voice = req.get("voice") or "af_heart"
            lang = req.get("lang") or "en-us"
            samples, rate = k.create(text, voice=voice, lang=lang)
            n += 1
            path = os.path.join(tmp, f"tts-{os.getpid()}-{n}.wav")
            write_wav(path, samples, rate)
            sys.stdout.write("@@TTS@@ " + json.dumps({"wav": path}) + "\n"); sys.stdout.flush()
        except Exception as e:  # noqa: BLE001
            sys.stdout.write("@@TTS@@ " + json.dumps({"error": str(e)}) + "\n"); sys.stdout.flush()

    os._exit(0)


if __name__ == "__main__":
    main()
