---
title: "medpsy — safe, accountable, on-device pharmacy triage"
---

*Built by the **medpsy-kent team** on the [QVAC SDK](https://qvac.tether.io/) + [QVAC MedPsy](https://huggingface.co/blog/qvac/medpsy).*

> A community-pharmacy **triage kiosk** that runs entirely on the device, reaches a **safe disposition**
> a pharmacist signs off, keeps a **tamper-evident record** of every decision, and lets a network of
> kiosks **learn from each other without any patient data ever leaving a device**.

It's point-of-care decision-support engineered for the three things medicine actually demands: it must
be **grounded** (answers tied to verified data, not vibes), **safe** (it fails toward escalation, never
silently downgrades an emergency), and **accountable** (every step is signed and auditable). All
on-device.

---

## Why

A pharmacy counter is the most common front door to healthcare, and the worst place for a cloud AI
service: patients are vulnerable, the data is sensitive, connectivity is unreliable, and a wrong
"you're fine" can kill. So the design constraints were non-negotiable:

- **On-device only.** No cloud APIs, no telemetry. Flip one env var (`MEDPSY_BACKEND=qvac`) and nothing
  leaves the machine — runs in airplane mode.
- **Safety over fluency.** The dangerous error is *under-triage* (missing an emergency). The whole
  architecture is biased toward catching it.
- **Accountable by construction.** If a machine influences a clinical decision, you must be able to
  prove *what it said and why* — months later, tamper-evidently.
- **Private collaboration.** A clinic network should get smarter together without pooling patient data.

## What it does

1. **Triage a patient** — a scripted 9-step flow *or* an AI-led interview, in **8 languages**, by
   **voice or text** (on-device speech). It produces a structured disposition: a band (🔴 emergency /
   🟡 urgent / 🟢 pharmacist-led / routine), severity, red flags, routing, and a safety-net.
2. **Ground every claim** — diagnosis codes are **verified ICD-10** looked up from the real 12k-code set
   (embedding search), never hallucinated; drug-interaction checks read a curated, replicated graph.
3. **Check itself** — an **independent safety-review gate** re-reads the evidence at conclusion and may
   *only escalate* (catch under-triage), ask one more targeted question, or autonomously consult a peer
   clinician device — never silently downgrade.
4. **Record everything** — a per-encounter, **ed25519-signed, hash-chained audit log**: every model
   exchange, tool call, the safety review, and the final code. Exportable; tamper shows up instantly.
5. **Learn as a network** — kiosks federate over peer-to-peer (Hyperswarm/Hypercore): a missed
   interaction taught on one kiosk is **jury-vetted** by other kiosks' models and, once a human
   promotes it, **every kiosk grounds on it** — with only drug names crossing the wire.
6. **Spot signals no single kiosk could** — PHI-free **federated pharmacovigilance**: each kiosk keeps
   de-identified co-occurrence tallies; the network sums them and an emerging pattern auto-proposes a
   candidate into the same human-gated learning loop.
7. **Train pharmacists — the Triage Preceptor** — practise like you would under a senior pharmacist:
   **interview** a simulated patient, then decide; the preceptor (our independent safety review)
   grades whether you screened the red flags and made the safe call. Also a "bring a real case"
   second-opinion mode. Simulated runs never touch the record, KB, or safety signals.

## See it in action

**▶ The whole flow, end to end** — an 8-step walkthrough where the *interview* does the work: a patient arrives with a vague **"chest pain"**, and medpsy asks one focused question at a time (onset → pleuritic screen → radiation → breathing/autonomic) until the red flags surface and it escalates to EMERGENCY → hospital record (history refines the plan, warfarin/INR-aware) → ED routing with an SBAR handover → clinician sign-off as a signed, tamper-evident record:

![Full walkthrough — Welcome → consent → a vague "chest pain" complaint → meds → a multi-question triage interview that reveals cardiac red flags step by step and escalates to EMERGENCY → FHIR record (prior MI + warfarin) → ED handover (SBAR) → practitioner sign-off (SHA-256 signed outcome)](media/medpsy-full-walkthrough-interview.gif)

**…and the same flow when the danger is obvious up front** — a clear ACS that escalates *immediately*, no questions needed. That's the safe failure mode: when the red flags are unambiguous, medpsy stops interviewing and escalates:

![Full walkthrough (fast escalation) — an unambiguous ACS escalates straight to EMERGENCY with zero questions → FHIR record (prior MI + warfarin) → ED handover → practitioner sign-off (SHA-256 signed outcome)](media/medpsy-full-walkthrough-heart-attack.gif)

…or step by step:

**1 · Guided sign-in & consent** — a multilingual, voice-enabled, consent-first start:

![Patient sign-in — welcome (8 languages + on-device voice), name, then the consent & capacity teach-back step; the rail advances 1✓→2](media/medpsy-patient-triage.gif)

**2 · The triage interview** — medpsy asks one focused question at a time, then concludes & safety-nets:

![Triage interview — a multi-question back-and-forth (onset/severity → red-flag screen → history) that de-escalates to "Routine — pharmacist care" with on-device references](media/medpsy-triage-interview.gif)

**3 · AI-led triage + an independent safety review** — medpsy conducts the interview and a second pass checks it:

![AI triage — a chest-pain case concludes EMERGENCY 10/10 with a verified ICD-10 (I21.9), and "independent safety review agreed"](media/medpsy-ai-triage.gif)

**4 · Tool-grounded clinical Q&A** — the agent recalls facts, screens interactions, and cites its sources:

![Agent — recall → screen_interactions → search_knowledge → a grounded answer on warfarin + ibuprofen](media/medpsy-agent-tool-grounded.gif)

**5 · The on-device knowledge graph + the learning loop** — verified facts, OKF export, P2P federation:

![Knowledge — kb:medical with verified ICD/interaction facts, OKF export, P2P federate, and the propose→vet→promote learn panel](media/medpsy-knowledge-base.gif)

**6 · A clinic network that learns — teach one, all learn** (jury-vetted, PHI-free):

![Mesh — teach one kiosk, the jury (including a signed peer vote) vets it, a pharmacist promotes it, and every kiosk learns it](media/medpsy-mesh-teach-one-all-learn.gif)

**7 · A signal no single kiosk could see** — federated pharmacovigilance crossing a threshold and auto-proposing a candidate:

![Signals — one more flagged encounter crosses the network threshold; scan auto-proposes a candidate into the human-gated loop](media/medpsy-signals-crossing.gif)

**8 · Every step signed and hash-chained** — the independent safety review sits in the tamper-evident trail:

![Audit — a verified, chain-intact timeline: reasoning → safety-review critique → EMERGENCY outcome, each row hash-stamped](media/medpsy-signed-audit-trail.gif)

**9 · Train pharmacists — the Triage Preceptor** — interview a simulated patient, decide, get graded:

![Preceptor — interview a simulated patient, then commit: "✓ correct disposition" + a red-flag screening breakdown (what you probed vs missed)](media/medpsy-preceptor-training.gif)

**10 · Verify all of it** — runs on this device (no cloud), measured by an eval, and every decision recorded:

![Trust — DEV/NO CLOUD backend, the agent eval (67% pass / 92% grounded / 4-4 red-flag escalation), and grounded+auditable provenance](media/medpsy-trust-on-device.gif)

## How it works

```
 patient ──voice/text──▶ triage agent ──tools──▶ verified ICD-10 + interaction graph
                              │                          (on-device embeddings + factstore)
                              ▼
                  independent SAFETY-REVIEW gate  ──uncertain?──▶ peer consult (P2P)
                       (escalate-only)
                              ▼
                   signed, hash-chained AUDIT  ◀── every step
                              │
        ┌─────────────────────┴───────────────────────┐
        ▼                                              ▼
  federated LEARNING (jury-vetted,             federated SAFETY SIGNALS
  human-gated, PHI-free)                       (de-identified, summed over the mesh)
        └──────────────  Hyperswarm / Hypercore mesh, no server  ──────────────┘
```

**The stack — QVAC is the engine, the identity layer, and the network, not a bolt-on:**

- **On-device inference** — QVAC MedPsy 4B (+1.7B) via the QVAC SDK (`loadModel`/`completion`/`embed`)
  or LM Studio in dev. Local GGUF; ICD-10 grounding over embeddings; on-device STT + TTS.
- **Trust & identity** — `hypercore-crypto` ed25519 keys per kiosk; signed audit bundles; signed
  membership rosters (tamper-evident, fail-closed).
- **P2P mesh** — Hyperswarm/Hypercore for KB replication, the jury/consult channel, encrypted encounter
  hand-off, and the safety-signal mesh. No central server.
- **Knowledge** — `@qvac/factstore` (bi-temporal, replicated triple store) + a knowledge-graph layer;
  candidate edges never ground until a human promotes them.

**Safety properties we actually test** — a deterministic 45-case acceptance matrix
(`npm run test:kiosk`) gates every change across four surfaces: the safety gate (no silent
de-escalation), federated signals (thresholds), federation lifecycle, and the PHI scrub. Plus an
asymmetric eval where a *missed* interaction is a hard failure.

## What makes it trustworthy

- **Grounded** — diagnosis codes are verified ICD-10 (never hallucinated); interactions read a curated, replicated graph.
- **Safe** — an independent safety-review gate that can only escalate, with an autonomous peer consult when uncertain.
- **Accountable** — a per-encounter, ed25519-signed, hash-chained audit of every step.
- **Private federated learning** — jury-vetted, human-gated, PHI-free; only drug names cross the wire.
- **Trains clinicians** — the Triage Preceptor: interview a patient, then graded against a safe answer.
- **Fully offline** — flip one env var and nothing leaves the device.

## Dig deeper

- **Safety-review gate** — [ARCHITECTURE → phased build](https://github.com/tfius/medpsy-kent/blob/main/qvac-app/ARCHITECTURE.md#phased-build)
- **Federated learning mesh** — [README → edge-learning loop](https://github.com/tfius/medpsy-kent/blob/main/qvac-app/README.md#edge-learning-loop-federated-phi-free)
- **Federated safety intelligence** — [README → pharmacovigilance](https://github.com/tfius/medpsy-kent/blob/main/qvac-app/README.md#federated-safety-intelligence-phi-free-pharmacovigilance)
- **Hardened mesh (signed roster + serve-side gating)** — [README → hardened mesh](https://github.com/tfius/medpsy-kent/blob/main/qvac-app/README.md#hardened-mesh-production-trust)
- **Triage Preceptor (clinical training)** — [README → Triage Preceptor](https://github.com/tfius/medpsy-kent/blob/main/qvac-app/README.md#triage-preceptor-clinical-training)
- **The 45-case acceptance matrix** — [`scripts/kiosk_matrix.mjs`](https://github.com/tfius/medpsy-kent/blob/main/qvac-app/scripts/kiosk_matrix.mjs)

## Run it

```bash
cd qvac-app && npm run start          # preflight → API → web kiosk
# a 2-kiosk mesh:
npm run kiosk -- --profile clinic-a --port 8787 --consult-code CLINIC
npm run kiosk -- --profile clinic-b --port 8788 --consult-code CLINIC   # auto-meshes in ~4 s
npm run test:kiosk                    # the 45-case safety/federation/privacy matrix
```

See [`README.md`](https://github.com/tfius/medpsy-kent/blob/main/qvac-app/README.md) and
[`ARCHITECTURE.md`](https://github.com/tfius/medpsy-kent/blob/main/qvac-app/ARCHITECTURE.md) for the full
picture, and [`JOURNAL.md`](https://github.com/tfius/medpsy-kent/blob/main/JOURNAL.md) for the build log.

---

*A human pharmacist reviews every result. medpsy is decision-support, not a diagnosis — and it's built
to prove it.*
