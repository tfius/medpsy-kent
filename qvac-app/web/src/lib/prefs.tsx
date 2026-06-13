// App preferences (kiosk-level, persisted, survive a "new patient" reset):
//   lang  — UI language + default TTS voice + STT locale hint
//   scale — text size (accessibility)
// Plus i18n for the patient-facing chrome — full translations live in ./i18n/*.json
// (one file per language). Strings fall back to English, then to the key itself, so
// partial translations degrade gracefully.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { setSpeechLang } from "./speech";
import en from "./i18n/en.json";
import sl from "./i18n/sl.json";
import es from "./i18n/es.json";
import zh from "./i18n/zh.json";
import yue from "./i18n/yue.json";
import de from "./i18n/de.json";
import it from "./i18n/it.json";
import fr from "./i18n/fr.json";

export type Lang = "en" | "de" | "fr" | "es" | "it" | "sl" | "zh" | "yue";
export type UiScale = "base" | "lg" | "xl";

export const LANGS: { code: Lang; label: string; flag: string; limited?: boolean }[] = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "it", label: "Italiano", flag: "🇮🇹" },
  { code: "zh", label: "中文（普通话）", flag: "🇨🇳" },
  { code: "de", label: "Deutsch", flag: "🇩🇪", limited: true }, // no German Kokoro voice (uses English)
  { code: "sl", label: "Slovenščina", flag: "🇸🇮", limited: true }, // no native voice (beta STT)
  { code: "yue", label: "粵語（廣東話）", flag: "🇭🇰" }, // SenseVoice STT + Cantonese VITS TTS
];

// Default TTS voice per UI language (used when the user hasn't picked one).
// Cantonese uses a dedicated sherpa-onnx Cantonese VITS voice ("yue_canto"); the rest
// are Kokoro voices (id prefix encodes language + gender).
export const VOICE_FOR_LANG: Record<Lang, string> = {
  en: "af_heart", sl: "af_heart", es: "ef_dora", zh: "zf_xiaoxiao", yue: "yue_canto",
  de: "af_heart", fr: "ff_siwis", it: "if_sara",
};

// Per UI language: which on-device speech we can actually do.
//  ttsPrefixes — Kokoro voice-id prefixes for this language ([] = no native voice)
//  stt         — Nemotron-3.5-ASR support tier (40 locales, 3 tiers)
export type SttTier = "full" | "broad" | "adapt" | "none";
export const LANG_SUPPORT: Record<Lang, { ttsPrefixes: string[]; ttsNote?: string; stt: SttTier; sttNote?: string }> = {
  en:  { ttsPrefixes: ["a", "b"], stt: "full" },
  de:  { ttsPrefixes: [],         stt: "full",  ttsNote: "no German voice — uses English" },
  fr:  { ttsPrefixes: ["f"],      stt: "full" },
  es:  { ttsPrefixes: ["e"],      stt: "full" },
  it:  { ttsPrefixes: ["i"],      stt: "full" },
  zh:  { ttsPrefixes: ["z"],      stt: "broad" },
  yue: { ttsPrefixes: ["yue"],    stt: "full" }, // SenseVoice STT + Cantonese VITS TTS (sherpa-onnx)
  sl:  { ttsPrefixes: [],         stt: "adapt", ttsNote: "no Slovenian voice — uses English", sttNote: "recognized but beta-quality" },
};

type Prefs = {
  lang: Lang; setLang: (l: Lang) => void;
  scale: UiScale; setScale: (s: UiScale) => void;
  demo: boolean; setDemo: (b: boolean) => void;        // testing: unlock all steps in the rail
  autoSpeak: boolean; setAutoSpeak: (b: boolean) => void; // read triage questions aloud
};
const Ctx = createContext<Prefs | null>(null);
const read = (k: string, d: string) => { try { return localStorage.getItem(k) || d; } catch { return d; } };

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(read("medpsy.lang", "en") as Lang);
  const [scale, setScale] = useState<UiScale>(read("medpsy.scale", "base") as UiScale);
  const [demo, setDemo] = useState<boolean>(read("medpsy.demo", "0") === "1");
  const [autoSpeak, setAutoSpeak] = useState<boolean>(read("medpsy.autoSpeak", "1") !== "0");
  useEffect(() => {
    try { localStorage.setItem("medpsy.lang", lang); } catch { /* ignore */ }
    document.documentElement.lang = lang;
    // Hand speech.ts this language's default voice + native voice prefixes so it speaks
    // in the right language (not a stale voice) and warms this language's models now.
    setSpeechLang(lang, { defaultVoice: VOICE_FOR_LANG[lang], prefixes: LANG_SUPPORT[lang].ttsPrefixes });
  }, [lang]);
  useEffect(() => { try { localStorage.setItem("medpsy.scale", scale); } catch { /* ignore */ } document.documentElement.dataset.scale = scale; }, [scale]);
  useEffect(() => { try { localStorage.setItem("medpsy.demo", demo ? "1" : "0"); } catch { /* ignore */ } }, [demo]);
  useEffect(() => { try { localStorage.setItem("medpsy.autoSpeak", autoSpeak ? "1" : "0"); } catch { /* ignore */ } }, [autoSpeak]);
  return <Ctx.Provider value={{ lang, setLang, scale, setScale, demo, setDemo, autoSpeak, setAutoSpeak }}>{children}</Ctx.Provider>;
}

export function usePrefs(): Prefs {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePrefs must be used within PrefsProvider");
  return c;
}

type Dict = Record<string, string>;
const STRINGS: Record<Lang, Dict> = { en, sl, es, zh, yue, de, it, fr };

export function useT(): (key: string) => string {
  const { lang } = usePrefs();
  return (key: string) => STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
}
