#!/usr/bin/env python3
"""Persistent Cantonese (+zh/en/ja/ko) STT worker — SenseVoice via sherpa-onnx.

Nemotron-3.5-ASR (the default English/European STT) does NOT handle Cantonese, so
when the kiosk language is Cantonese the Node server routes dictation here instead.
SenseVoice-Small is loaded ONCE and stays resident; each request transcribes a
16 kHz mono WAV path. Runs fully on-device via onnxruntime (no @qvac native build).

Protocol (mirrors stt_worker.py so the Node manager is identical):
  stdin:  one JSON request per line: {"wav": "/tmp/x.wav", "lang": "yue"}
          (a bare WAV path on a line is also accepted)
  stdout: "@@READY@@"                    once the model is loaded + warmed
          "@@STT@@ {\"text\": \"...\"}"  one line per transcription
          "@@STT@@ {\"error\": \"...\"}" on failure
Env: MEDPSY_SENSEVOICE_ONNX (model.int8.onnx), MEDPSY_SENSEVOICE_TOKENS (tokens.txt),
     MEDPSY_SPEECH_LANG (SenseVoice language: yue|zh|en|ja|ko|auto, default "yue").
"""
import json
import os
import signal
import sys
import wave

signal.signal(signal.SIGTERM, lambda *_: os._exit(0))

ONNX = os.environ.get("MEDPSY_SENSEVOICE_ONNX")
TOKENS = os.environ.get("MEDPSY_SENSEVOICE_TOKENS")
LANG = os.environ.get("MEDPSY_SPEECH_LANG", "yue")


def log(msg: str) -> None:
    sys.stderr.write(f"[sherpa_stt] {msg}\n"); sys.stderr.flush()


def emit(obj: dict) -> None:
    sys.stdout.write("@@STT@@ " + json.dumps(obj, ensure_ascii=False) + "\n"); sys.stdout.flush()


def read_wave(path):
    """Read a WAV file -> (float32 mono samples in [-1,1], sample_rate)."""
    import numpy as np
    with wave.open(path, "rb") as w:
        rate, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:  # 8-bit unsigned PCM
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return data, rate


def main() -> None:
    if not ONNX or not os.path.exists(ONNX):
        log(f"SenseVoice model not found: {ONNX}"); sys.exit(2)
    if not TOKENS or not os.path.exists(TOKENS):
        log(f"tokens.txt not found: {TOKENS}"); sys.exit(2)

    import sherpa_onnx

    log(f"loading SenseVoice {ONNX} (lang={LANG}) ...")
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=ONNX,
        tokens=TOKENS,
        num_threads=2,
        language=LANG,        # "yue" = Cantonese; "" / "auto" lets the model detect
        use_itn=True,         # inverse text normalization (numbers, punctuation)
        debug=False,
    )

    def transcribe(path: str) -> str:
        samples, sample_rate = read_wave(path)
        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples)
        recognizer.decode_stream(stream)
        return (stream.result.text or "").strip()

    sys.stdout.write("@@READY@@\n"); sys.stdout.flush()
    log("ready")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            path = line
            if line.startswith("{"):
                path = json.loads(line).get("wav", "")
            emit({"text": transcribe(path)})
        except Exception as e:  # noqa: BLE001 - report, keep the worker alive
            emit({"error": str(e)})

    os._exit(0)


if __name__ == "__main__":
    main()
