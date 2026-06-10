# Roadmap — next lifecycle

## Snapshot (starting point)
Working demo: 9-stage kiosk, triage duel, on-device ICD-10 grounding, multilingual STT/TTS
(incl. Cantonese), live translation, SHA-256 signing, three-identity audit model.

Gaps:
- **QVAC SDK is the least-exercised path** — LLM runs on LM Studio (dev); speech on
  parakeet.cpp/kokoro/sherpa bypasses. The `qvac` backend exists but hasn't run end-to-end.
- No formal clinical eval of triage decisions; ICD ~85% exact (not regression-tracked).
- Zero automated tests; single-machine dev wiring; not packaged as a device/app.

## Architecture decision: extend, don't rebuild
QVAC-native = **fix the existing app**, not a new one. The provider abstraction
(`src/backend.js`, `MEDPSY_BACKEND=lmstudio|qvac`) is the designed seam, and the frontend's
only LLM dependency is OpenAI-style `/v1`. `@qvac/sdk` is a library (no built-in OpenAI
server), so the single missing piece is a `/v1/chat/completions` + `/v1/embeddings` shim in
`src/server.js` backed by the provider. A "new app" is only ever a Phase-3 Bare/Expo shell
that *wraps* this same UI + logic.

## The fork
Decision gate after the hackathon: **(A) submit and stop** or **(B) pursue as product/pilot**.
Phase 0 serves both; Phases 1–4 assume B.

| Phase | Goal | Horizon |
|---|---|---|
| 0 · Hackathon finish line | Tight submission that *shows QVAC* | days |
| 1 · QVAC-native for real | "Local-first" literally true — no LM Studio | 1–2 wks |
| 2 · Clinical safety & eval | Trustworthy triage, not just plausible | ongoing |
| 3 · Productization | Real offline device/app + interop | B-track |
| 4 · Pilot & governance | Supervised site, regulatory posture | B-track |

### Phase 0 — Hackathon finish line
- Run `MEDPSY_BACKEND=qvac` end-to-end at least once (LLM + embeddings on-device).
- 2-min demo + script: airplane mode → triage → "guessed ICD X → verified Y" → Cantonese
  voice → signed audit record.
- README/pitch leading with privacy/offline/QVAC (STACK.md is the exhibit).
- `npm run check` green on a fresh machine; friend confirms SETUP-LINUX.md.
- Verify every graceful-degradation path.

### Phase 1 — QVAC-native for real
- Add `/v1/chat/completions` (streaming) + `/v1/embeddings` shim to `src/server.js`, backed
  by the provider abstraction; point Vite `/v1` proxy at `:8787`.
- Stabilize the @qvac/sdk native install (partial-extraction / Bare-runtime fragility) —
  pin versions, script the repair.
- `qvac` backend parity: completion + embed; rebuild the ICD index with QVAC embeddings
  (768-d nomic vs 1024-d GTE mismatch forces a re-embed).
- Swap flat-cosine ICD for `@qvac/rag` (ragIngest/ragSearch).
- Evaluate QVAC speech (Supertonic TTS, parakeet-transcription) vs the bypasses; keep the
  more reliable. TurboQuant / KV-cache tune for kiosk hardware.

### Phase 2 — Clinical safety & eval
- Eval harness: triage cases vs ESI/Manchester; over/under-triage + red-flag recall.
- Track ICD exact-match as a regression metric (~85% baseline).
- Guardrails: never invent a code (grounded), never drop a red flag — explicit safety-net
  verification stage; capture practitioner sign-off (stage H) for a feedback loop.
- Language parity across the 8 languages + the translation boundary.

### Phase 3 — Productization (B)
- Package as the actual QVAC runtime (Bare/Expo) — a real offline app, signed/offline updates.
- Kiosk hardening: lockdown, per-patient session reset, interruption recovery, accessibility.
- Real interop: FHIR/HL7/X12 + SBAR exports wired to a sandbox EHR/pharmacy; audit export.

### Phase 4 — Pilot & governance (B)
- Regulatory posture (decision-support classification), PII/data governance.
- LoRA fine-tune medpsy to a clinic's formulary; P2P delegated inference for hard cases.
- Supervised pilot at one site; clinician feedback → eval loop.

## Cross-cutting / debt
- Automated tests (none today) + eval harness in CI.
- Pin the Vite/API ports (multi-project collisions bit us twice).
- Keep the nothing-leaves-the-device invariant as features grow.

## Top risks
1. QVAC native fragility could undermine the whole pitch → Phase 0/1 priority.
2. No clinical eval = no credibility past a demo → Phase 2 is the gate for B.
3. Scope creep — it already does a lot; freeze features until QVAC-native + eval are solid.
