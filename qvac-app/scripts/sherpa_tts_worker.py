#!/usr/bin/env python3
"""Persistent Cantonese TTS worker — VITS (vits-cantonese-hf-xiaomaiiwn) via sherpa-onnx.

Kokoro has no Cantonese voice (it would read Cantonese text with Mandarin
pronunciation), so when the kiosk language is Cantonese the Node server routes
read-aloud here. The VITS model is loaded ONCE and stays resident; each request
synthesizes a 16-bit mono WAV. Fully on-device via onnxruntime.

Protocol (mirrors tts_worker.py so the Node manager is identical):
  stdin:  one JSON request per line: {"text": "...", "speed": 1.0}
  stdout: "@@READY@@"                          once the model is loaded + warmed
          "@@TTS@@ {\"wav\": \"/tmp/...wav\"}"  path to a WAV per request
          "@@TTS@@ {\"error\": \"...\"}"        on failure
Env: MEDPSY_CANTO_ONNX (model .onnx), MEDPSY_CANTO_LEXICON (lexicon.txt),
     MEDPSY_CANTO_TOKENS (tokens.txt), MEDPSY_CANTO_RULE (rule.fst, optional).
"""
import json
import os
import signal
import struct
import sys
import tempfile

signal.signal(signal.SIGTERM, lambda *_: os._exit(0))

ONNX = os.environ.get("MEDPSY_CANTO_ONNX")
LEXICON = os.environ.get("MEDPSY_CANTO_LEXICON")
TOKENS = os.environ.get("MEDPSY_CANTO_TOKENS")
RULE = os.environ.get("MEDPSY_CANTO_RULE")  # optional text-normalization FST


def log(msg: str) -> None:
    sys.stderr.write(f"[sherpa_tts] {msg}\n"); sys.stderr.flush()


def write_wav(path: str, samples, rate: int) -> None:
    import numpy as np
    pcm = np.clip(np.asarray(samples, dtype="float32"), -1.0, 1.0)
    data = (pcm * 32767.0).astype("<i2").tobytes()
    with open(path, "wb") as f:
        f.write(b"RIFF"); f.write(struct.pack("<I", 36 + len(data))); f.write(b"WAVE")
        f.write(b"fmt "); f.write(struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16))
        f.write(b"data"); f.write(struct.pack("<I", len(data))); f.write(data)


def main() -> None:
    for label, p in (("model", ONNX), ("lexicon", LEXICON), ("tokens", TOKENS)):
        if not p or not os.path.exists(p):
            log(f"{label} not found: {p}"); sys.exit(2)

    import sherpa_onnx

    log(f"loading Cantonese VITS {ONNX} ...")
    tts = sherpa_onnx.OfflineTts(
        sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=ONNX, lexicon=LEXICON, tokens=TOKENS,
                ),
                num_threads=2,
                provider="cpu",
            ),
            rule_fsts=RULE if (RULE and os.path.exists(RULE)) else "",
            max_num_sentences=1,
        )
    )
    try:
        tts.generate("你好。", sid=0, speed=1.0)  # warm
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
            speed = float(req.get("speed", 1.0))
            audio = tts.generate(text, sid=0, speed=speed)
            n += 1
            path = os.path.join(tmp, f"canto-tts-{os.getpid()}-{n}.wav")
            write_wav(path, audio.samples, audio.sample_rate)
            sys.stdout.write("@@TTS@@ " + json.dumps({"wav": path}) + "\n"); sys.stdout.flush()
        except Exception as e:  # noqa: BLE001
            sys.stdout.write("@@TTS@@ " + json.dumps({"error": str(e)}) + "\n"); sys.stdout.flush()

    os._exit(0)


if __name__ == "__main__":
    main()
