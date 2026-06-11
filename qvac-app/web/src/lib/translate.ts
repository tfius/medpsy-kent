// Bridge between the patient's language and medpsy, which only reasons in English.
// The triage conversation is conducted in English internally (canonical history sent
// to medpsy); the patient's free text is translated IN to English before each medpsy
// call, and medpsy's questions/conclusions are translated OUT to the patient's language
// for display + speech. A separate LM Studio model does the translation (medpsy itself
// is not a translator). Everything still runs locally through the same /v1 proxy.
//
// Fails safe: on any error the original text is returned unchanged, so a missing/clashing
// translation model degrades to "send the patient's own words" rather than breaking triage.
import { chat } from "./openai";
import { audit } from "./audit";
import type { Lang } from "./prefs";
import type { Triage } from "./triage";

const MODEL = import.meta.env.VITE_TRANSLATE_MODEL || "gemma-4-26b-a4b-it";

// Full language names the translator understands (our short codes mean nothing to it).
const LANG_NAME: Record<string, string> = {
  en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian",
  sl: "Slovenian", zh: "Mandarin Chinese", yue: "Cantonese (write in traditional Chinese characters)",
};

// Identical (from,to,text) translations recur a lot (result fields, voice previews,
// repeated answers); cache them so we never pay the round-trip twice.
const cache = new Map<string, Promise<string>>();

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && /^["'“”«]/.test(t) && /["'“”»]$/.test(t)) return t.slice(1, -1).trim();
  return t;
}

async function llmTranslate(text: string, from: string, to: string): Promise<string> {
  const src = LANG_NAME[from] || from;
  const dst = LANG_NAME[to] || to;
  const sys =
    `You are a professional medical translator. Translate the user's message from ${src} to ${dst}. ` +
    `Output ONLY the translation — no quotes, no notes, no preamble, no explanation. ` +
    `Preserve clinical meaning, drug names, numbers and units exactly. Keep any uppercase ` +
    `structured labels (e.g. DECISION:, ICD-10:) and medical codes unchanged. Keep it natural ` +
    `for a patient to read and hear. If the message is already in ${dst}, return it unchanged.`;
  const out = await chat(
    [{ role: "system", content: sys }, { role: "user", content: text }],
    { model: MODEL, temperature: 0, maxTokens: 2048 },
  );
  return stripQuotes(out) || text;
}

/** Translate `text` from one language code to another. No-op when equal/empty; never throws. */
export async function translateText(text: string, from: string, to: string): Promise<string> {
  const src = (text || "").trim();
  if (!src || from === to) return text;
  const key = `${from}>${to}>${src}`;
  let p = cache.get(key);
  if (!p) {
    // Cache the in-flight Promise (not just the result) so identical concurrent calls —
    // e.g. the same question localized twice, or repeated answers — share one round-trip.
    // Fail safe: on any error resolve to the original text so triage never breaks.
    p = llmTranslate(src, from, to).catch(() => text);
    // Audit the translation boundary (what medpsy saw vs. what the patient said/heard).
    p.then((out) => { if (out && out !== src) audit.translation({ dir: from === "en" ? "out" : "in", from, to, src, out }); }).catch(() => {});
    if (cache.size > 500) cache.clear(); // soft cap for very long kiosk sessions
    cache.set(key, p);
  }
  return p;
}

/** Patient language -> English, for feeding medpsy. */
export const toEnglish = (text: string, lang: string): Promise<string> =>
  translateText(text || "", lang, "en");

/** English -> patient language, for display + speech. */
export const fromEnglish = (text: string, lang: string): Promise<string> =>
  translateText(text || "", "en", lang);

/**
 * Translate a parsed triage result for the PATIENT view. Only the two fields the patient
 * view actually renders are translated — `routing` ("what to do") and `safetyNet` ("what
 * to watch for"); everything else (decision/severity/band/icd, and the clinician-only
 * condition/redFlags) stays English so colour-banding, ICD grounding, the SBAR handover
 * and the clinician sign-off keep working on canonical English. The stored encounter
 * outcome stays English; this returns a display-only copy. The two fields translate
 * concurrently, so latency ≈ a single call.
 */
export async function localizeTriage(t: Triage, lang: Lang): Promise<Triage> {
  if (lang === "en") return t;
  const [routing, safetyNet] = await Promise.all([
    fromEnglish(t.routing, lang),
    fromEnglish(t.safetyNet, lang),
  ]);
  return { ...t, routing, safetyNet };
}
