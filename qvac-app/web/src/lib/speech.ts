// Voice for the kiosk. TTS prefers on-device QVAC (/api/tts) and falls back to the
// browser's Web Speech API, so "read aloud" works whether or not the QVAC speech server
// is running. STT uses the browser SpeechRecognition for the demo; the on-device QVAC
// path is POST /api/stt (16 kHz WAV) for native/Expo clients.

export async function speak(text: string): Promise<void> {
  if (!text) return;
  try {
    const r = await fetch("/api/tts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (r.ok && (r.headers.get("content-type") || "").includes("audio")) {
      await playBlob(await r.blob()); // on-device QVAC (Chatterbox) TTS
      return;
    }
    throw new Error("tts endpoint unavailable");
  } catch {
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    }
  }
}

function playBlob(blob: Blob): Promise<void> {
  return new Promise((resolve) => {
    const a = new Audio(URL.createObjectURL(blob));
    a.onended = () => resolve();
    a.onerror = () => resolve();
    a.play().catch(() => resolve());
  });
}

export function sttSupported(): boolean {
  return typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
}

// Capture a single spoken answer; calls onText with the transcript. Returns a stopper.
export function listenOnce(onText: (t: string) => void, onErr?: (e: string) => void): () => void {
  const SR = (window as unknown as Record<string, unknown>).SpeechRecognition ||
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  if (!SR) { onErr?.("speech recognition not supported in this browser"); return () => {}; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rec = new (SR as any)();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e: { results: { [k: number]: { [k: number]: { transcript: string } } } }) =>
    onText(e.results[0][0].transcript);
  rec.onerror = (e: { error?: string }) => onErr?.(e.error || "speech error");
  rec.start();
  return () => rec.stop();
}
