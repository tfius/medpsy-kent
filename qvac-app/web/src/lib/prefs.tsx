// App preferences (kiosk-level, persisted, survive a "new patient" reset):
//   lang  — UI language + default TTS voice + STT locale hint
//   scale — text size (accessibility)
// Plus a tiny i18n for the patient-facing chrome. Strings fall back to English,
// then to the key itself, so partial translations degrade gracefully.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "sl" | "es";
export type UiScale = "base" | "lg" | "xl";

export const LANGS: { code: Lang; label: string; flag: string }[] = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "sl", label: "Slovenščina", flag: "🇸🇮" },
  { code: "es", label: "Español", flag: "🇪🇸" },
];

// Default Kokoro voice per UI language (used when the user hasn't picked one).
export const VOICE_FOR_LANG: Record<Lang, string> = { en: "af_heart", sl: "af_heart", es: "ef_dora" };

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
const STRINGS: Record<Lang, Dict> = {
  en: {
    "help": "Get help", "help.aria": "Get help from a staff member",
    "emergency": "Emergency", "newPatient": "New patient", "textSize": "Text size", "language": "Language",
    "help.title": "Need a hand?", "help.notified": "A staff member has been notified and is coming to help you.",
    "help.emergencyTitle": "Is this an emergency?",
    "help.emergencyBody": "If someone has severe chest pain, trouble breathing, fainting, or is at risk right now — don't wait.",
    "help.call": "Call emergency services", "help.close": "Back",
    "trust": "A pharmacist reviews every result. You can stop anytime.",
    "result.urgency": "How urgent", "result.meaning": "What this means", "result.do": "What to do now",
    "result.watch": "When to get help", "result.next": "Continue",
    "band.RED": "Emergency — act now", "band.AMBER": "Get seen today", "band.GREEN": "Routine — pharmacist care",
    "none.meds": "No medicines", "none.allergies": "No allergies", "dontknow": "I'm not sure",
    "step.identify": "Welcome", "step.consent": "Your OK", "step.context": "What's wrong",
    "step.intake": "Your meds", "step.triage": "Questions", "step.history": "Records",
    "step.route": "Next steps", "step.validate": "Clinician", "step.billing": "Coding",
  },
  sl: {
    "help": "Pomoč", "help.aria": "Poišči pomoč osebja",
    "emergency": "Nujno", "newPatient": "Nov pacient", "textSize": "Velikost besedila", "language": "Jezik",
    "help.title": "Potrebujete pomoč?", "help.notified": "Osebje je obveščeno in prihaja na pomoč.",
    "help.emergencyTitle": "Je to nujno?",
    "help.emergencyBody": "Če ima nekdo hudo bolečino v prsih, težave z dihanjem, omedlevico ali je ogrožen — ne čakajte.",
    "help.call": "Pokliči nujno pomoč", "help.close": "Nazaj",
    "trust": "Vsak rezultat pregleda farmacevt. Kadarkoli lahko prenehate.",
    "result.urgency": "Kako nujno", "result.meaning": "Kaj to pomeni", "result.do": "Kaj storiti zdaj",
    "result.watch": "Kdaj poiskati pomoč", "result.next": "Naprej",
    "band.RED": "Nujno — ukrepajte takoj", "band.AMBER": "Obiščite zdravnika danes", "band.GREEN": "Rutinsko — oskrba farmacevta",
    "none.meds": "Brez zdravil", "none.allergies": "Brez alergij", "dontknow": "Nisem prepričan/a",
    "step.identify": "Dobrodošli", "step.consent": "Privolitev", "step.context": "Težava",
    "step.intake": "Zdravila", "step.triage": "Vprašanja", "step.history": "Kartoteka",
    "step.route": "Napotitev", "step.validate": "Zdravnik", "step.billing": "Obračun",
  },
  es: {
    "help": "Pedir ayuda", "help.aria": "Pedir ayuda al personal",
    "emergency": "Emergencia", "newPatient": "Nuevo paciente", "textSize": "Tamaño del texto", "language": "Idioma",
    "help.title": "¿Necesita ayuda?", "help.notified": "Se ha avisado al personal y viene a ayudarle.",
    "help.emergencyTitle": "¿Es una emergencia?",
    "help.emergencyBody": "Si alguien tiene dolor de pecho intenso, dificultad para respirar, desmayos o está en riesgo — no espere.",
    "help.call": "Llamar a emergencias", "help.close": "Volver",
    "trust": "Un farmacéutico revisa cada resultado. Puede detenerse cuando quiera.",
    "result.urgency": "Urgencia", "result.meaning": "Qué significa", "result.do": "Qué hacer ahora",
    "result.watch": "Cuándo buscar ayuda", "result.next": "Continuar",
    "band.RED": "Emergencia — actúe ya", "band.AMBER": "Que le vean hoy", "band.GREEN": "Rutina — atención del farmacéutico",
    "none.meds": "Sin medicamentos", "none.allergies": "Sin alergias", "dontknow": "No estoy seguro/a",
    "step.identify": "Bienvenida", "step.consent": "Permiso", "step.context": "Su problema",
    "step.intake": "Medicación", "step.triage": "Preguntas", "step.history": "Historial",
    "step.route": "Siguiente", "step.validate": "Clínico", "step.billing": "Facturación",
  },
};

export function useT(): (key: string) => string {
  const { lang } = usePrefs();
  return (key: string) => STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
}
