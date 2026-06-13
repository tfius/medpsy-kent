#!/usr/bin/env python3
"""Persistent on-device STT worker for the medpsy kiosk.

Loads NVIDIA Nemotron-3.5-ASR ONCE via parakeet.cpp's C-API (ctypes), then
transcribes 16 kHz mono WAV file paths read line-by-line from stdin, printing one
JSON line per result. The model stays resident, so each transcription is fast
(~0.2-0.5 s) instead of reloading the 938 MB model per request — this mirrors the
nemotron-asr-test harness.

Protocol (so stray C-library stdout can't corrupt it):
  stdout: "@@READY@@"                                 once the model is loaded + warmed
          "@@STT@@ {\"text\": \"...\", \"locale\": \"es\"}"  one line per transcription
          "@@STT@@ {\"error\": \"...\"}"                on failure
  stdin:  one request per line — either a bare WAV path (locale = default), or a JSON
          object {"wav": "<path>", "lang": "<locale>"} to transcribe in a specific
          locale. "locale" in the reply is the locale ACTUALLY used (the request locale,
          or "auto" if the model didn't recognize it and we fell back).
ggml/Metal diagnostics go to stderr (inherited by the Node server).

Nemotron is one resident multilingual model: a locale is just a per-call prompt, so the
model never reloads when the language changes. Unknown locales make the C-API fail, so we
fall back to "auto" and remember the bad locale to skip the wasted retry next time.

Env: MEDPSY_PARAKEET_LIB (libparakeet.dylib), MEDPSY_STT_GGUF (model),
     MEDPSY_SPEECH_LANG (default locale when a request doesn't specify one, default "auto").
"""
import ctypes
import json
import os
import re
import signal
import struct
import sys
import tempfile

# ggml-metal asserts on context teardown (GGML_ASSERT rsets->data count == 0), so
# exit hard — skip C++ static destructors — when the server stops us. The model
# memory is reclaimed by the OS anyway.
signal.signal(signal.SIGTERM, lambda *_: os._exit(0))

LIB = os.environ.get("MEDPSY_PARAKEET_LIB")
GGUF = os.environ.get("MEDPSY_STT_GGUF")
LANG = os.environ.get("MEDPSY_SPEECH_LANG", "auto")
TAG = re.compile(rb"<[^>]+>")          # strip the model's inline language tags


def log(msg: str) -> None:
    sys.stderr.write(f"[stt_worker] {msg}\n"); sys.stderr.flush()


def emit(obj: dict) -> None:
    sys.stdout.write("@@STT@@ " + json.dumps(obj) + "\n"); sys.stdout.flush()


def silent_wav(path: str, seconds: float = 0.4, rate: int = 16000) -> None:
    """Write a tiny silent 16 kHz mono PCM WAV (used to pre-compile Metal kernels)."""
    n = int(seconds * rate)
    data = b"\x00\x00" * n
    with open(path, "wb") as f:
        f.write(b"RIFF"); f.write(struct.pack("<I", 36 + len(data))); f.write(b"WAVE")
        f.write(b"fmt "); f.write(struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16))
        f.write(b"data"); f.write(struct.pack("<I", len(data))); f.write(data)


def main() -> None:
    if not LIB or not os.path.exists(LIB):
        log(f"libparakeet not found: {LIB}"); sys.exit(2)
    if not GGUF or not os.path.exists(GGUF):
        log(f"model not found: {GGUF}"); sys.exit(2)

    lib = ctypes.CDLL(LIB)
    lib.parakeet_capi_load.restype = ctypes.c_void_p
    lib.parakeet_capi_load.argtypes = [ctypes.c_char_p]
    lib.parakeet_capi_transcribe_path_lang.restype = ctypes.c_void_p
    lib.parakeet_capi_transcribe_path_lang.argtypes = [
        ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p]
    lib.parakeet_capi_free_string.argtypes = [ctypes.c_void_p]
    lib.parakeet_capi_last_error.restype = ctypes.c_char_p
    lib.parakeet_capi_last_error.argtypes = [ctypes.c_void_p]

    log(f"loading {GGUF} ...")
    ctx = lib.parakeet_capi_load(GGUF.encode())
    if not ctx:
        log("failed to load model"); sys.exit(3)

    bad_locales: set[str] = set()  # locales this model rejected — skip straight to auto

    def _try(path: str, locale: str):
        ptr = lib.parakeet_capi_transcribe_path_lang(ctx, path.encode(), 0, locale.encode())
        if not ptr:
            err = (lib.parakeet_capi_last_error(ctx) or b"").decode("utf-8", "replace")
            raise RuntimeError(err or "transcribe failed")
        raw = ctypes.cast(ptr, ctypes.c_char_p).value or b""
        lib.parakeet_capi_free_string(ptr)
        return re.sub(r"\s+", " ", TAG.sub(b"", raw).decode("utf-8", "replace")).strip()

    def transcribe(path: str, lang: str = ""):
        """Transcribe in `lang` (falling back to MEDPSY_SPEECH_LANG, then "auto").
        Returns (text, locale_actually_used)."""
        want = (lang or LANG or "auto").strip() or "auto"
        if want in bad_locales:
            want = "auto"
        try:
            return _try(path, want), want
        except RuntimeError as e:
            if want == "auto":
                raise
            # Unknown/unsupported locale for this model — remember it, fall back to auto.
            bad_locales.add(want)
            log(f"locale '{want}' rejected ({e}); falling back to auto")
            return _try(path, "auto"), "auto"

    # Pre-warm: a throwaway transcribe compiles the Metal kernels now (~once, ~10 s)
    # so the first real request is fast instead of "stuck".
    try:
        warm = os.path.join(tempfile.gettempdir(), "stt_warm.wav")
        silent_wav(warm)
        transcribe(warm)
        log("warmed up")
    except Exception as e:  # noqa: BLE001 - warm-up is best-effort
        log(f"warm-up skipped ({e})")

    sys.stdout.write("@@READY@@\n"); sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        # Either a bare path (back-compat) or a JSON request {"wav","lang"}.
        path, lang = line, ""
        if line.startswith("{"):
            try:
                req = json.loads(line)
                path, lang = req.get("wav", ""), req.get("lang", "")
            except Exception as e:  # noqa: BLE001 - malformed request line
                emit({"error": f"bad request: {e}"}); continue
        try:
            text, locale = transcribe(path, lang)
            emit({"text": text, "locale": locale})
        except Exception as e:  # noqa: BLE001 - report, keep the worker alive
            emit({"error": str(e)})

    os._exit(0)  # stdin closed (server gone): skip the ggml-metal teardown assert


if __name__ == "__main__":
    main()
