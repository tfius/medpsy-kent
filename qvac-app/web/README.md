# MedPsy Triage — kiosk UI

A 9-page kiosk/tablet UI for the local-first triage app, one page per phase of
[`../ARCHITECTURE.md`](../ARCHITECTURE.md). **Triage (step 5) is fully implemented** as the
multi-step duel; the other pages are scaffolds wired into the flow, to expand next.

**Stack:** Vite + React + TypeScript. Clinical design, Inter font (system fallback, offline-safe),
responsive down to mobile. Talks to an **OpenAI-compatible** endpoint, so it runs against **LM Studio**
today and a **QVAC CLI server** later with no code change.

## Run (with LM Studio serving `medpsy-4b` on :1234)
```bash
cd qvac-app/web
npm install
npm run dev        # opens http://localhost:5173
```
The dev server proxies `/v1` → `http://localhost:1234` (avoids CORS). Override the target/model:
```bash
VITE_LLM_URL=http://localhost:1234 VITE_LLM_MODEL=medpsy-4b npm run dev
```

## The 9 pages
1. **Identify** — kiosk login (→ patient identity / MRN).
2. **Consent & capacity** — informed consent + teach-back; branch to human/proxy pathway.
3. **Context** — presenting complaint (→ situation identity).
4. **Intake** — type/voice answers; patient-reported meds/conditions/allergies.
5. **Triage** — ✅ **multi-step duel**: medpsy asks one question at a time, re-triages each turn,
   concludes with `DECISION / SEVERITY 0–10 + 🔴🟡🟢 / RED FLAGS / CONDITION / ICD-10 / ROUTING / SAFETY-NET`.
6. **History** — conditional FHIR fetch (urgent only) → re-triage.
7. **Route & notify** — severity-driven destination.
8. **Validation** — practitioner sign-off (→ outcome identity, immutable/signed).
9. **Code & bill** — ICD-10 grounding + claim from the validated diagnosis.

## Notes
- The browser can't run the QVAC SDK directly; in-browser use targets the **QVAC CLI server** (OpenAI
  API) or LM Studio. For true on-device inference, productionize with **Expo (React Native)** — QVAC's
  supported runtime — or **Tauri** with a Node sidecar; the page flow, duel state machine, and backend
  client are kept framework-light to port.
- The encounter store (`src/store.tsx`) models the three identities (patient / situation / outcome).
