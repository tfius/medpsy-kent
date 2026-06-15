# How we used the QVAC SDK

### medpsy — a 100% on-device, peer-to-peer medical-triage kiosk.
**QVAC is the inference engine, the identity layer, and the P2P network — not a bolt-on.**

---

**1 · On-device inference — `@qvac/sdk`**  *(no cloud, no API keys, works in airplane mode)*
`loadModel` + `completion` → **medpsy-4B** triage reasoning · `embed` → **ICD-10 grounding** (12,246 codes) · `transcribe` → **speech-to-text** · `textToSpeech` → **read-aloud**.
All from local GGUF/ONNX. One switch — `MEDPSY_BACKEND=qvac` — and nothing leaves the device.

```js
const llm = await loadModel({ modelSrc: "medpsy-4b.gguf", modelType: "llm" });
for await (const tok of completion({ modelId: llm, history }).tokenStream) …
```

**2 · P2P federation — QVAC's Hyperswarm / Hypercore stack**
`hypercore-crypto` → per-kiosk **ed25519 identity** + **signed, tamper-evident** audit bundles.
`hyperswarm` + `hypercore` → **federated-learning mesh** (a drug interaction taught on one kiosk reaches all), **federated pharmacovigilance signals**, **encrypted encounter hand-off** (kiosk → pharmacist), knowledge-graph replication. Peer-to-peer, **no central server**.

**3 · Knowledge & retrieval**
`@qvac/factstore` → bi-temporal, replicated store for learned interactions ·
`@qvac/rag` → evaluated `ragIngest`/`ragSearch`, measured vs. exact cosine, kept the winner *(engineering rigor)*.

---

`Patient ▸ QVAC transcribe → completion → embed → ICD-10 ▸ ed25519-signed audit ▸ Hyperswarm ▸ peer kiosks`

> **Bottom line:** QVAC runs the model, signs every record, and federates learning across kiosks — **fully offline, privacy by construction.**
