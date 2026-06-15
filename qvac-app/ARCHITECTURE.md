# AI-assisted triage — architecture

A design for a **local-first, offline, hospital-deployed** AI triage assistant built on the QVAC SDK.
The patient (or a nurse) interacts at a kiosk/tablet; everything runs on-device or on the hospital
network — **no internet, no cloud, patient data never leaves the building**. The AI is decision-support:
a medical practitioner (always signed in) validates every consequential outcome.

## Principles
- **Local-first / offline:** LLM, embeddings/RAG, STT, TTS, vision run on-device via QVAC; the only
  network call is to the **hospital EHR/payer** over the internal LAN.
- **Data minimization:** don't open a full medical record unless clinically warranted — history is
  pulled **after** triage and **only** for urgent/severe cases (privacy + audit + speed win).
- **Triage-first:** recognize emergencies from the *presentation*, not by first reading the chart
  (how real triage works) — so it's fast and resilient to a slow/absent EHR.
- **Human-in-the-loop:** the model triages and drafts; a practitioner confirms. Never autonomous
  diagnosis or prescribing.
- **Informed consent + capacity:** consent is *verified* (teach-back), not a checkbox; the AI screens
  comprehension and flags capacity concerns but never determines capacity or gates emergency care — a
  human does. Care is never withheld for lack of consent in an emergency (doctrine of necessity).
- **Grounded, not hallucinated:** ICD-10 codes and dosing come from verified lookups/RAG.
- **Auditable & shareable by design:** three linked identities — **patient** (who), **situation** (the
  episode), **outcome** (the result) — keep PII isolated so every action is traceable and each record can
  be shared with the right party (paramedics / hospital / pharmacy) at **minimum-necessary** PII.

## End-to-end flow
```
   Patient at kiosk/tablet (hospital LAN, no internet)
 1 IDENTIFY → CONSENT → CAPACITY CHECK
        │     card/QR/biometric · plain-language consent (incl. the conditional EHR pull) ·
        │     teach-back: patient restates it → comprehension is verified, not assumed
        ├─ NOT demonstrated / minor / unresponsive / acutely distressed / declines AI
        │        └─► SEPARATE PATHWAY: human/proxy-assisted triage; emergency → staff NOW.
        │            (Red-flag escalation & care are NEVER gated by consent — doctrine of necessity.)
        └─ capable + understands + consents ▼
 2 CONTEXT ASSEMBLY ─────────── session context: demographics from ID, presenting complaint,
        │                       language/accessibility, modality setup — NO EHR history yet
 3 MULTIMODAL INTAKE ────────── questions shown as text + optionally spoken (TTS); patient answers
        │                       by VOICE (STT) or by TYPING; camera for visual red-flags;
        │                       capture PATIENT-REPORTED meds / conditions / allergies
 4 TRIAGE (multi-step duel) ─── medpsy asks one question at a time, re-triages each turn →
        │                       DECISION / SEVERITY 0–10 + 🔴🟡🟢 / RED FLAGS / CONDITION /
        │                       ROUTING / SAFETY-NET   (history-free pass; escalate on red flag)
        │
        ├─ 🟢 GREEN / routine ───────────────────────────────────┐  (skip EHR history)
        │                                                         │
        └─ 🔴/🟡 urgent or severe → 5 FETCH HISTORY (FHIR over LAN)│
                                     → history-aware REFINEMENT    │  (interactions, comorbidities,
                                       (re-triage; enrich/escalate)│   allergy-safe options)
                                                                   ▼
 6 ROUTE & NOTIFY ───────────── 🔴 EMS/ED + page attending NOW · 🟡 same-day + auto-book ·
        │                       🟢 pharmacist queue.  Emergency action is immediate.
        ▼
 7 PRACTITIONER VALIDATION ──── the always-present clinician confirms/edits the outcome.
        │                       (Safety floor does NOT wait on validation for 🔴.)
        ▼
 8 CODE & BILL ──────────────── from the VALIDATED diagnosis: ICD-10 grounding → claim (X12 837);
                                eligibility (X12 270/271) checked async earlier. Write back to EHR (audited).
```

## Two history layers (the key idea)
History is not absent before triage — it's **patient-reported**; the EHR pull is the authoritative
deep-dive reserved for cases that need it.

| Layer | When | Source | Purpose |
|-------|------|--------|---------|
| **Patient-reported** | always, in intake (step 3) | the patient (voice/forms) | makes the first triage history-aware *enough* (meds, conditions, allergies) |
| **EHR-authoritative** | post-triage, urgent/severe only (step 5) | hospital EHR via FHIR | complete + verified; adds interactions/precautions, informs routing & handover |

Optional middle ground: a *cheap* critical-flags fetch (allergy + anticoagulant only) even for GREEN,
if the EHR exposes it lightly.

## Phases in detail

**1 Identify → consent → capacity check.** Patient authenticates (card / QR / staff-assisted); open the
encounter; a practitioner is signed in throughout. Consent is **informed and verified**, not a checkbox:
- **Disclose** (plain language, typed or spoken): what the AI does, that it is decision-support and **not
  a diagnosis**, that a practitioner validates the outcome, the right to stop anytime, data use, the
  **conditional EHR retrieval** ("if urgent, we'll pull your hospital record"), and the **sharing scope**
  (which downstream parties — pharmacy / hospital / paramedics — may receive the outcome).
- **Verify understanding via teach-back** — a short multi-step dialogue (a mini-"duel"): the patient
  restates the consent in their own words / answers 1–2 comprehension checks; medpsy scores comprehension.
- **Branch:**
  - *Capable + understands + consents* → proceed to step 2.
  - *Comprehension not demonstrated* → first **assist** (re-explain simpler, switch to voice, translate,
    retry); only persistent difficulty routes onward.
  - *Minor / unconscious / delirium or cognitive impairment / intoxication / unresolved language barrier
    / declines the AI* → **separate pathway** (below).

See "Consent comprehension & capacity" for the boundary: the AI **screens comprehension and flags
concerns; a human makes the capacity determination** and care is never withheld for lack of consent.

**2 Context assembly.** Assemble *session* context only — demographics from the ID, the one-line
presenting complaint, language/accessibility prefs (drives TTS/STT), camera availability. **No EHR
history pull here.**

**3 Multimodal intake.** Gather symptoms conversationally. Questions are shown on screen (with colour)
and optionally spoken via TTS; the **patient answers by voice (STT) or by typing** — their choice, for
accessibility, noisy/private rooms, or preference. Camera is optional (visual red-flags). Either way,
**explicitly capture patient-reported high-yield history**: current medications (esp. anticoagulants,
insulin, immunosuppressants), major conditions, allergies, recent surgery/pregnancy. This is what makes
the upcoming triage history-aware without an EHR round-trip.

**4 Triage — a multi-step duel.** medpsy runs the **multi-turn interview** (this repo's interview/triage
prompt + duel engine): it asks **one focused question at a time**, the patient answers (typed or spoken),
and it **re-triages each turn** until it can conclude — escalating immediately the moment a red flag
emerges. Output: `DECISION / SEVERITY 0–10 + colour / RED FLAGS / CONDITION / ROUTING / SAFETY-NET`.
Sensitivity-first: catch the emergency. A provisional grounded ICD-10 is shown for context.

**5 Conditional history retrieval.** Gate: fetch the EHR record **only if** `DECISION ∈ {EMERGENCY,
URGENT}` **or** `SEVERITY ≥ 5` (or the triage explicitly *requests* history to disambiguate). Then run a
**history-aware refinement**: re-evaluate with meds/comorbidities/allergies. The refinement may escalate
or add precautions (e.g., "on apixaban → bleeding precautions; tell EMS") — it should rarely *downgrade*
urgency. GREEN/routine cases skip this entirely.

**6 Route & notify.** Severity colour drives routing (research Area 4): 🔴 activate EMS / send to ED and
**page the attending immediately**; 🟡 same-day GP/nurse + **auto-book** a slot; 🟢 pharmacist queue with
a safety-net. The notification delivers the structured triage + verified code to the right person.
Act-vs-validate asymmetry: for 🔴 the safety action fires *now* (validation concurrent); for 🟡/🟢 routing
queues the case and the practitioner validates before treatment.

**7 Practitioner validation.** The always-present clinician (nurse/doctor/pharmacist as appropriate)
reviews, edits if needed, and confirms. This is the human-in-the-loop sign-off — but the **safety floor
for 🔴 does not wait on it** (escalation already happened in step 6).

**8 Code & bill.** From the **validated** diagnosis (not the AI draft): ground the final ICD-10 code,
assemble encounter/procedure codes, and build the claim (X12 **837**). Eligibility (X12 **270/271**) can
run async once identity is known. Write the validated outcome + codes back to the EHR, fully audit-logged.

## Consent comprehension & capacity (the separate pathway)
Informed consent = disclosure + **capacity** + voluntariness. We verify the *understanding* part by
**teach-back**, not by a tap on "I agree".

**The AI's boundary.** The consent module **screens comprehension and raises concerns**; it does **not**
make the legal capacity determination and **cannot exclude anyone from care**. Capacity is presumed,
decision-specific, and time-specific; a human practitioner makes the call. This prevents the AI from
wrongly shutting out people with low literacy, anxiety, accents, or transient distress.

**Who goes to the separate (human/proxy) pathway:**
- Minors (below age of consent) → guardian/proxy.
- Unconscious / unresponsive / acutely distressed → staff immediately (emergency; consent waived).
- Cognitive impairment, delirium, intoxication → human-assisted (fluctuating capacity).
- Language barrier not resolved by on-device translation → interpreter / human.
- Comprehension not demonstrated *after assistance* (re-explain, voice, translate, retry) → human-assisted, **not rejected**.
- Patient declines the AI → standard human triage (declining the AI ≠ declining care).

**Safety override.** Red-flag detection and escalation run regardless of consent state. A visibly
incapacitated/collapsing patient triggers a **staff alert now** — never a "separate AI queue". The
consent/capacity gate governs only the *self-service AI* path.

**Record (evidence of informed consent).** Log the consent version shown, the teach-back restatement,
comprehension checks + result (pass / flagged), timestamp, modality (typed/spoken), and the branch taken
— audit-logged alongside the triage.

## Input/output modalities — all on-device QVAC capabilities
The patient can **type or speak** their answers; questions are always on-screen (text + colour) and
optionally spoken. Pick per patient/room — no modality is required.
- **Text (default fallback):** questions on screen, patient types answers. Works everywhere, no audio.
- **TTS — speak the questions** (QVAC Text-to-Speech / ONNX): accessibility, low literacy/vision, hands-free.
- **STT — hear the answers** (QVAC Transcription via parakeet-cpp; **Nemotron-3.5-ASR** 0.6B GGUF —
  40+ languages, real-time cache-aware streaming, prompt-conditioned, WER 0): spoken replies → text that
  drives the next triage turn; multilingual + on-device translation for non-native speakers. Implemented
  in `src/speech.js` (`transcribe`) + `/api/stt`.
- **Vision — camera snapshot** (QVAC OCR + image classification / vision-language):
  - OCR reads paper forms, prescriptions, ID/insurance cards into structured fields.
  - Image analysis surfaces *supportive* visual red-flags — facial asymmetry (FAST/stroke prompt),
    pallor/cyanosis, respiratory distress, rashes/wounds, reduced consciousness. **Vision is a triage
    accelerator / red-flag flagger, NOT a diagnosis** — it raises priority and prompts the clinician,
    never concludes alone. (Skin-tone/quality bias caveats belong in drift monitoring, Area 5.)

Loop: `question (text ± TTS) → patient answers (typed OR spoken→STT) → [optional camera → vision
red-flags] → medpsy re-triages → next question`. Everything local; nothing streamed off-device.

## Design rationale & trade-offs
- **Why history-on-demand:** speed (skip EHR for the GREEN majority), data-minimization/privacy (fewer
  PHI accesses), resilience (works if EHR is slow/down). Cost: a history-free pass can under-stratify
  history-dependent presentations (ADEs, comorbidity-modified risk).
- **Mitigation:** patient-reported history in intake (always) + EHR fetch for urgent (authoritative) +
  conservative bump when history is uncertain on a borderline case. Net: the urgent subset is fully
  history-aware before routing; the routine subset is history-aware from self-report.
- **Why validation after route-&-notify:** emergencies must escalate without waiting for sign-off; the
  practitioner (always present) validates concurrently/at pickup. Reversibility scales with urgency.
- **Why bill last:** the billed code must reflect the *validated* clinical truth, not the model's draft.

## QVAC capability mapping
| Pipeline step | QVAC capability | API |
|---------------|-----------------|-----|
| Triage reasoning | LLM completion (medpsy GGUF) | `loadModel` + `completion` |
| History RAG + ICD-10 grounding | Text embeddings + RAG | `embed` / `ragIngest` / `ragSearch` |
| Speak questions | Text-to-Speech (Chatterbox GGML) | `textToSpeech` / `textToSpeechStream` |
| Hear answers | Transcription — Parakeet / **Nemotron-3.5-ASR** (0.6B, 40+ langs, streaming, WER 0) | `transcribe` / `transcribeStream` (`parakeet-transcription`) |
| Non-native speakers | Translation (NMT / Bergamot) | translation capability |
| Read forms / ID cards | OCR (ONNX) | OCR capability |
| Visual red-flags | Image classification / vision-language | classification / VLA |
| Hard-case escalation | P2P delegated inference | Holepunch delegation |

## Identity & data model (auditable + shareable)
Three linked identities, each with a stable ID — separating PII (patient) from the clinical/operational
records (situation, outcome) is what makes the system both auditable and safely shareable.

| Identity | What | Stable ID | FHIR | Holds |
|----------|------|-----------|------|-------|
| **Patient** (who) | the person — the PII anchor | MRN / national id | `Patient` | name, DOB, identifiers (held once, tightly controlled) |
| **Situation** (episode) | this triage encounter | situation_id | `Encounter` (+`Consent`) | complaint, intake, consent record, vitals, kiosk/time — refs patient *by id* |
| **Outcome** (result) | the validated triage | outcome_id | `ClinicalImpression`/`RiskAssessment` + `Condition`(ICD-10) + `ServiceRequest` | decision/severity/colour, red flags, verified ICD-10, routing, validating practitioner, model version — refs situation+patient *by id* |

Chain: **Patient `1—*` Situation `1—*` Outcome.**

- **Audit:** append-only log referencing `(patient_id, situation_id, outcome_id, actor, action,
  timestamp, before→after)` — full traceability with **no raw PII in the logs**. Outcomes are
  **immutable once validated**; corrections appended as new hash-linked versions (FHIR `Provenance` /
  `AuditEvent`).
- **Share (minimum-necessary, recipient-scoped):**
  - 🔴 **Paramedics/ED** → full situation+outcome + full PII (emergency necessity).
  - 🟡 **Hospital/GP** → encounter+outcome for booking/follow-up + identify (consent).
  - 🟢 **Pharmacy** → outcome (condition, action, allergies, meds) + identify-to-dispense (consent).
  Shared as a signed FHIR `Bundle`; **every disclosure is itself an audit event** (recipient, time, basis).
- **Provenance & verifiability:** records/bundles carry provenance (model version, validating
  practitioner) and are **cryptographically signed** → tamper-evident, attributable, verifiable even
  offline / P2P (QVAC fit). Consent (step 1) records the **sharing scope** (which recipients); emergency
  necessity overrides but is still logged.

## Data & standards
- **EHR exchange:** FHIR R4 (preferred) / HL7 v2.  **Terminologies:** ICD-10 (billing/diagnosis —
  grounded here), SNOMED CT (findings), LOINC (labs), RxNorm/dm+d (meds).  **Billing:** X12 270/271
  (eligibility), 837 (claim).

## On-device memory (why it fits a kiosk)
On edge hardware the **KV cache** — not the weights — is usually the memory bottleneck: it grows with
`context × layers × heads × 2(K+V) × precision` and, for long contexts, can exceed the model itself.
QVAC's **TurboQuant** quantizes the KV cache (≈2–4× smaller), which directly enables the things this
design needs on a tablet: our **≥8k-token** reasoning generations, the **full interview + history-RAG**
context, and **more concurrent kiosk sessions** (KV cache is per-session) — or running **medpsy-4b**
rather than the 1.7b on the same device, with less need to fall back to P2P delegation.
Caveat: KV-cache quantization can slightly affect quality on very long contexts → **re-run the
adversarial safety bank** against the quantized on-device setup to confirm the 0-dangerous-failures
result still holds (eval-as-gate).

## Federated learning — the edge-learning mesh

A clinic network of kiosks that **gets smarter from every correction while no patient data leaves the
device** — federated learning *without gradients, a cloud, or a data leak*. It reuses the on-device
agent, the `@qvac/factstore`, P2P consult, and the audit chain.

**The loop.** A clinician correction (or an encounter) → medpsy **distils** a candidate interaction
edge (`distillEdges`; drug names + a *generalized* mechanism only) → it lands `proposed` and is **never
grounded** (the agent's `screen_interactions` ignores un-promoted edges) → a **jury** of on-device AIs
(this kiosk + peers, each its own medpsy) cast **ed25519-signed** verdicts → a clinician **promotes** a
survivor → it enters the shared graph, **federates** to every kiosk, and their agents ground on it.
Every step is recorded in a tamper-evident `kb-learning` audit chain — you can trace *why* the network
believes any learned fact.

**Why it's PHI-free by construction.** The only thing on the wire is a knowledge edge: `{drugA, drugB,
severity, note}` + provenance. The generalization *is* the de-identification; a `sanitizeNote` strips
stray identifiers (names/ages/dates/MRNs) as defence-in-depth, and the distiller is fed only the
structured outcome, not the patient's words. The lifecycle mirrors the patient-fact one
(`proposed → vetted → promoted | rejected`) on the same bi-temporal store.

**Transport & topology.** One hyperswarm swarm per kiosk on a topic derived from a shared *consult
code* (`sha256("medpsy-consult:v1:"+code)`), joined as both server and client — it is **both the jury
and the mesh discovery**. On connect, kiosks exchange a *signed* announce of their `kb:medical`
hypercore key; receiving one replicates that core (hypercore) and merges new/changed edges into the
local graph. Knowledge propagates **transitively** (each kiosk re-asserts merged edges into its own
core, which others replicate) and **converges** (dedup by statementId + trust state — no loops). Merge
is **event-driven** (the peer core's `append` event, ~1 s) with a slow interval backstop. The swarm
**self-heals** (escalating re-discovery + re-announce) so simultaneous starts, late joins, and restarts
all settle; a returning kiosk catches up what it missed.

**Trust model (opt-in).** Default is an **open mesh** (the shared code is the membership) — fine for a
demo. For production, an **allowlist** of authorized device pubkeys (config `members`, or
`MEDPSY_CONSULT_MEMBERS`) gates everything: only allowlisted, signature-verified devices may auto-join
and only their votes count — which matters because a member's *promoted* edge federates without
re-vetting. The roster travels with the shared config file. Hardened two ways: a **signed roster**
(`src/roster.js`, `npm run roster`) makes the allowlist tamper-evident — the clinic admin signs it with
their device key and each kiosk accepts it only if it verifies against the configured issuer, failing
**closed** (trust nobody) if a configured roster fails to verify; and a **serve-side gate** — kiosks
exchange a signed `kb-hello` on connect and hand over their `kb:medical` key (the thing that lets a peer
replicate the graph) **only** to verified members, so a non-member can't even obtain the data to merge.

## Federated safety intelligence — PHI-free pharmacovigilance

The edge-learning loop federates an *explicit* correction; this federates an **implicit signal** —
the network detects an emerging interaction **no single kiosk has enough data to see**, still with no
PHI on the wire (`src/signals.js`, `/signals`).

**The idea.** Each kiosk privately tallies, per drug **pair** seen together during triage, how often a
concern was flagged — **integers only, never patient data**. It publishes *only its own* tallies on the
shared `kb:medical` graph (predicate `cooccurs_with`, keyed by its device pubkey) so they replicate like
any KB fact. Every kiosk **sums the tallies across contributors**; when a pair crosses a threshold
(≥2 kiosks, enough flagged events, a high enough flagged/seen rate) it **auto-proposes a candidate**
into the *existing* vet/promote loop — where a human pharmacist still vets and promotes before it ever
grounds. The agentic triage feeds this automatically at conclusion (the patient's med pairs, flagged
when the disposition is concerning); the `/signals` view also drives it manually.

**Why it stays clean.** Aggregation folds each replicated **peer log directly** (self's `kb:medical` +
each `kb:peer:*`) rather than re-mirroring peers' numbers into the local core — so there's no transitive
double-counting and no unbounded growth from re-asserting others' tallies. Signals use a distinct
predicate, so grounding/screening (which folds only `interacts_with`) never grounds on a raw signal —
it can influence triage *only* by surviving the human-gated promotion. What crosses the wire is a drug
pair + two integers; everything else is the same loop, store, mesh, and audit chain.

## Security, safety, governance
- **Network:** device ↔ hospital systems over LAN only; no outbound internet; TLS + mutual auth.
- **Data:** PHI encrypted at rest on-device; ephemeral encounter context cleared after sign-off; minimal retention.
- **Safety floor:** red-flag presentations always escalate regardless of history/voice/vision inputs or validation latency.
- **Regulatory:** likely SaMD (MDR/FDA); the human-in-the-loop "decision-support not diagnosis" posture is what keeps it deployable.
- **Consent record:** the verified-consent evidence (teach-back, comprehension result, modality, branch) is stored with the encounter.
- **Audit & drift:** every decision logged (inputs, model version, verified codes, consent record,
  practitioner action); post-market monitoring of under/over-triage rates and demographic bias (Area 5).

## Phased build
1. **MVP (now):** typed complaint → triage → grounded ICD-10 → routing label. (`qvac-app` is the core.)
2. **+ Patient-reported history** captured in intake and fed to triage.
3. **+ Voice:** TTS questions / STT answers (spoken interview).
4. **+ Conditional EHR history:** FHIR fetch gated on severity → history-aware refinement.
5. **+ Routing & notifications:** severity-driven dispatch to EHR inbox/pager; practitioner validation UI.
6. **+ Billing:** eligibility/claim drafts from validated codes.
7. **+ Vision, P2P escalation, monitoring:** camera red-flags; delegate hard cases; drift/bias dashboards.
8. **+ Federated edge-learning mesh:** corrections → distilled, jury-vetted, signed knowledge that federates
   kiosk-to-kiosk (opt-in membership), no PHI on the wire. *(Built — see the section above + `/mesh`.)*
9. **+ Federated safety intelligence:** PHI-free pharmacovigilance — per-kiosk de-identified co-occurrence
   tallies summed across the mesh; a crossed threshold auto-proposes into the human-gated learning loop.
   Hardened mesh (signed roster, serve-side gating). *(Built — see the section above + `/signals`.)*
10. **+ Autonomous safety-review gate (agentic triage):** the AI-led interview no longer concludes in one
    pass — a second, independent on-device clinician pass re-reads the evidence and may **only escalate**
    the disposition (catch under-triage / missed red flags), never de-escalate. It can also **ask one more
    targeted question** to resolve a plausible-but-unconfirmed red flag (bounded per encounter), and
    **autonomously fetch a signed peer second opinion** over the mesh when the case is uncertain (advisory,
    can only raise the band). Auditable; fails open. *(Built — `superviseConclusion` in
    `src/triage-agent.js`, surfaced on `/atriage`.)*
