# medpsy — 60-second demo script

A tight, repeatable demo of the four hero capabilities: **on-device**, **federated learning mesh**,
**federated safety intelligence**, and the **safety-review gate + signed audit**. Record your screen
(e.g. QuickTime / OBS) at 1280×800+, narrate over it. Total ≈ 60–70 s.

> **Pre-flight (do BEFORE recording — keeps every scene fast and predictable):** run
> `bash scripts/demo_stage.sh`. It starts two meshed kiosks (A:8787, B:8788, code `DEMO`) + the web,
> pre-seeds the Signals scene to *just below* threshold so one click crosses it on camera, and pre-runs
> one agentic triage so its audit timeline is ready. Open the web URL it prints (usually `:5174`).

---

### Scene 0 · On-device, no cloud — *(0:00–0:08)*
- **Show:** the **📊 Trust** page.
- **Do:** nothing — just rest on "DEV · NO CLOUD", the backend line, and the eval bars.
- **Say:** *"medpsy is a community-pharmacy triage assistant that runs entirely on-device — no cloud, no
  telemetry. The model, the verified codes, and the network are all local."*

### Scene 1 · A clinic network that learns together — *(0:08–0:28)*
- **Show:** the **🕸 Mesh** page (Kiosk A = teacher, Kiosk B online).
- **Do:** click **"▶ Teach on Kiosk A → watch the mesh"** (scenario *amiodarone + simvastatin*). Let it
  run (~15 s): A distils a candidate → the jury votes (your kiosk **+ a signed vote from Kiosk B**) → you
  promote → **Kiosk B lights up "learned … (major)"**.
- **Say:** *"Teach a missed interaction on one kiosk. Its jury of on-device AIs — including a
  cryptographically-signed vote from a peer device — vets it. A pharmacist promotes it, and every kiosk
  on the mesh now catches it. Only drug names ever cross the wire — no patient data."*

### Scene 2 · A signal no single kiosk could see — *(0:28–0:44)*
- **Show:** the **📡 Signals** page (pre-seeded just below threshold: 2 flagged across 2 kiosks).
- **Do:** click **⚠️ +concern** on Kiosk A once → both cards flip to **"signal ✓"** (3 flagged / 2 kiosks
  / rate crosses). Then click **📡 scan → propose** → the candidate drops into the learning loop.
- **Say:** *"Each kiosk keeps de-identified tallies — integers, never patient data. Alone it's noise;
  summed across the network it crosses a threshold and auto-proposes a candidate into the same
  human-gated loop. Federated pharmacovigilance, fully private."*

### Scene 3 · It checks itself — and proves it — *(0:44–0:58)*
- **Show:** the **🛡 Audit** page → open the pre-run agentic-triage encounter (the EMERGENCY one).
- **Do:** scroll the timeline so **`atriage.critique`** (the safety review) is visible **between** the
  reasoning and the **EMERGENCY outcome**; point out every row is **✓ intact** (hash-chained).
- **Say:** *"Every AI-led triage passes an independent safety review that can only escalate — never
  silently downgrade an emergency. And every step is ed25519-signed and hash-chained, so you can prove
  exactly what it decided and why."*

### Scene 4 · Close — *(0:58–1:05)*
- **Show:** the GitHub page (`https://tfius.github.io/medpsy-kent/`) or the kiosk's 🔒 trust bar.
- **Say:** *"Grounded. Safe. Accountable. On-device. **medpsy**."*

---

### Tips
- The only slow scene is #1 (the live jury/promote, ~15 s) — that's fine on camera; everything else is
  one click thanks to the pre-staging.
- If a scene stalls on model latency, cut and re-take that scene — the staging is idempotent (re-run
  `demo_stage.sh`).
- Hero alternates if you want shorter: lead with Scene 1 (mesh) — it's the most visceral "many devices
  collaborating" shot.
