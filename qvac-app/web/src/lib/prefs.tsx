// App preferences (kiosk-level, persisted, survive a "new patient" reset):
//   lang  — UI language + default TTS voice + STT locale hint
//   scale — text size (accessibility)
// Plus i18n for the patient-facing chrome — full translations live in ./i18n/*.json
// (one file per language). Strings fall back to English, then to the key itself, so
// partial translations degrade gracefully.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import en from "./i18n/en.json";
import sl from "./i18n/sl.json";
import es from "./i18n/es.json";
import zh from "./i18n/zh.json";
import yue from "./i18n/yue.json";

export type Lang = "en" | "sl" | "es" | "zh" | "yue";
export type UiScale = "base" | "lg" | "xl";

export const LANGS: { code: Lang; label: string; flag: string }[] = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "sl", label: "Slovenščina", flag: "🇸🇮" },
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "zh", label: "中文（普通话）", flag: "🇨🇳" },
  { code: "yue", label: "粵語（廣東話）", flag: "🇭🇰" },
];

// Default Kokoro voice per UI language (used when the user hasn't picked one).
// Kokoro ships Mandarin (z*) voices but no Cantonese, so Cantonese falls back to a
// Mandarin voice — it reads the text with Mandarin pronunciation.
export const VOICE_FOR_LANG: Record<Lang, string> = {
  en: "af_heart", sl: "af_heart", es: "ef_dora", zh: "zf_xiaoxiao", yue: "zf_xiaoxiao",
};

type Prefs = {
  lang: Lang; setLang: (l: Lang) => void;
  scale: UiScale; setScale: (s: UiScale) => void;
};
const Ctx = createContext<Prefs | null>(null);
const read = (k: string, d: string) => { try { return localStorage.getItem(k) || d; } catch { return d; } };

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(read("medpsy.lang", "en") as Lang);
  const [scale, setScale] = useState<UiScale>(read("medpsy.scale", "base") as UiScale);
  useEffect(() => { try { localStorage.setItem("medpsy.lang", lang); } catch { /* ignore */ } document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { try { localStorage.setItem("medpsy.scale", scale); } catch { /* ignore */ } document.documentElement.dataset.scale = scale; }, [scale]);
  return <Ctx.Provider value={{ lang, setLang, scale, setScale }}>{children}</Ctx.Provider>;
}

export function usePrefs(): Prefs {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePrefs must be used within PrefsProvider");
  return c;
}

type Dict = Record<string, string>;
const STRINGS: Record<Lang, Dict> = { en, sl, es, zh, yue };

export function useT(): (key: string) => string {
  const { lang } = usePrefs();
  return (key: string) => STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
}
