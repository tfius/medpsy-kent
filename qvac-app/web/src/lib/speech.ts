// Voice for the kiosk. TTS prefers on-device QVAC (/api/tts) and falls back to the
// browser's Web Speech API, so "read aloud" works whether or not the QVAC speech server
// is running. STT uses the browser SpeechRecognition for the demo; the on-device QVAC
// path is POST /api/stt (16 kHz WAV) for native/Expo clients.

// Selectable on-device TTS voice (Kokoro). Persisted so the choice sticks.
export interface Voice { id: string; name?: string; language?: string; gender?: string; grade?: string }
const VOICE_KEY = "medpsy.ttsVoice";
export function getVoice(): string { try { return localStorage.getItem(VOICE_KEY) || ""; } catch { return ""; } }
export function setVoice(v: string): void { try { localStorage.setItem(VOICE_KEY, v); } catch { /* ignore */ } }

// Fetch the voices the on-device engine offers (empty if the server/engine has none).
export async function fetchVoices(): Promise<Voice[]> {
  try {
    const r = await fetch("/api/tts/voices");
    if (r.ok) return (await r.json()).voices || [];
  } catch { /* server not running */ }
  return [];
}

export async function speak(text: string, voice?: string): Promise<void> {
  if (!text) return;
  try {
    const r = await fetch("/api/tts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: voice || getVoice() || undefined }),
    });
    if (r.ok && (r.headers.get("content-type") || "").includes("audio")) {
      await playBlob(await r.blob()); // on-device TTS (Kokoro, with fallback)
      return;
    }
    throw new Error("tts endpoint unavailable");
  } catch {
    if ("speechSynthesis" in window) {
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      });
    }
  }
}

let currentAudio: HTMLAudioElement | null = null;
function playBlob(blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    const a = new Audio(URL.createObjectURL(blob));
    currentAudio = a;
    const done = () => { if (currentAudio === a) currentAudio = null; resolve(); };
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  });
}

// Stop any in-progress speech (Kokoro audio + Web Speech). Call before listening
// so a spoken question doesn't bleed back into the recognizer.
export function stopSpeaking(): void {
  try { currentAudio?.pause(); currentAudio = null; } catch { /* ignore */ }
  try { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); } catch { /* ignore */ }
}

// STT here is fully on-device: we record the mic, encode a 16 kHz mono WAV in the
// browser, and POST it to /api/stt (Nemotron-3.5-ASR via parakeet.cpp). No cloud
// speech API — the browser's Web Speech API sends audio to a server, so it's avoided.
export function sttSupported(): boolean {
  return typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder !== "undefined" &&
    !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);
}

export type ListenPhase = "recording" | "transcribing";
export interface ListenControl { stop: () => void; cancel: () => void }

// Record one spoken turn, auto-stopping on a short silence (or manual stop / cap),
// transcribe it on-device, and call onText with the result. `stop` finishes and
// transcribes; `cancel` discards without transcribing.
export function listenLocal(
  onText: (t: string) => void,
  onErr?: (e: string) => void,
  onPhase?: (p: ListenPhase) => void,
): ListenControl {
  let cancelled = false;
  let mr: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let ac: AudioContext | null = null;
  let raf = 0;
  const chunks: BlobPart[] = [];

  const cleanup = () => {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    ac?.close().catch(() => {});
  };

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        cleanup();
        if (cancelled) return;
        try {
          onPhase?.("transcribing");
          const wav = await blobToWav16k(new Blob(chunks, { type: mr?.mimeType || "audio/webm" }));
          const r = await fetch("/api/stt", {
            method: "POST", headers: { "content-type": "audio/wav" }, body: wav,
          });
          if (!r.ok) throw new Error(`on-device STT unavailable (${r.status})`);
          onText(((await r.json()).text || "").trim());
        } catch (e) {
          onErr?.(e instanceof Error ? e.message : String(e));
        }
      };
      onPhase?.("recording");
      mr.start();

      // Voice-activity auto-stop: stop after ~1.2 s of silence once speech began.
      ac = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const an = ac.createAnalyser(); an.fftSize = 2048;
      ac.createMediaStreamSource(stream).connect(an);
      const data = new Float32Array(an.fftSize);
      const SILENCE_MS = 1200, MIN_MS = 500, MAX_MS = 15000, RMS_TH = 0.012;
      const start = performance.now();
      let lastLoud = start, spoke = false;
      const tick = () => {
        if (!mr || mr.state !== "recording") return;
        an.getFloatTimeDomainData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now();
        if (rms > RMS_TH) { lastLoud = now; spoke = true; }
        if (now - start > MAX_MS || (spoke && now - start > MIN_MS && now - lastLoud > SILENCE_MS)) {
          mr.stop(); return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch (e) {
      cleanup();
      onErr?.(e instanceof Error ? e.message : String(e));
    }
  })();

  return {
    stop: () => { if (mr && mr.state === "recording") mr.stop(); },
    cancel: () => { cancelled = true; if (mr && mr.state === "recording") mr.stop(); else cleanup(); },
  };
}

// Encode mono Float32 [-1,1] samples as a 16-bit PCM WAV Blob.
function encodeWav16(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const wr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); wr(8, "WAVE");
  wr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wr(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// Decode a recorded blob and resample to 16 kHz mono via OfflineAudioContext.
async function blobToWav16k(blob: Blob): Promise<Blob> {
  const ac = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  const decoded = await ac.decodeAudioData(await blob.arrayBuffer());
  await ac.close();
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  return encodeWav16(rendered.getChannelData(0), 16000);
}
