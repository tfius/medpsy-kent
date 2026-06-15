---
name: federated-safety-intelligence
description: qvac-app phase 9 — PHI-free federated pharmacovigilance; per-kiosk co-occurrence tallies summed over the mesh auto-propose into the human-gated learn loop
metadata:
  type: project
---

qvac-app phase 9 ("the big thing"): **federated safety intelligence** — `src/signals.js`, `/api/signals`, web `/signals` (📡 Signals).

The mesh detects an emerging drug-drug interaction no single kiosk has enough data to see, with **zero PHI on the wire**. Each kiosk privately tallies per drug PAIR a `seen` and `flagged` count (integers only). Published as `cooccurs_with` facts on the *existing* `kb:medical` core, keyed by device pubkey. Aggregation (`aggregateSignals`) folds self's `kb:medical` PLUS each replicated `kb:peer:*` log **directly** (no re-mirroring → no transitive double-count). `detectSignals` threshold = `{minContributors:2, minFlagged:3, minRate:0.3}` — the ≥2 contributors IS the federation requirement. Crossers `autoProposeSignals` → the *existing* `proposeEdge`, landing in the same human-gated vet→promote loop (see [[edge-learning loop]] / part of the [[p2p-handoff-knowledge]] mesh).

Key design invariants (don't regress): signals use a **distinct predicate** so grounding/screening (folds only `interacts_with`) never grounds a raw signal; agentic-triage conclusion auto-observes med pairs (adverse = concerning disposition) — additive, must NOT touch the scripted 9-step flow.

Built alongside federated **hardening**: signed roster (`src/roster.js`, `npm run roster`, `MEDPSY_ROSTER_ISSUER`, fail-closed) + serve-side `kb-hello` gate (hand KB key only to verified members). Smoke: `scripts/federated_signals_smoke.mjs` (PASS). Commits 03f535f, 457c76e, 5b6780d.
