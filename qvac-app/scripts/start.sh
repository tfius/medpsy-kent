#!/usr/bin/env bash
# Run the whole kiosk stack with one command: preflight → API server (:8787) → web kiosk (Vite).
# (LM Studio on :1234 you start yourself — see the preflight output.)
set -uo pipefail
cd "$(dirname "$0")/.."

# Backend: lmstudio (dev default) or qvac (fully on-device). In QVAC mode, route the web's
# /v1 proxy at the server's on-device shim instead of LM Studio — one fully-local command.
BACKEND="${MEDPSY_BACKEND:-lmstudio}"
if [ "$BACKEND" = "qvac" ]; then
  export VITE_LLM_URL="${VITE_LLM_URL:-http://localhost:8787}"
  echo "→ backend: QVAC (on-device) — web /v1 → server shim ($VITE_LLM_URL); no LM Studio needed"
else
  echo "→ backend: LM Studio (dev) — start it on :1234 (see preflight)"
fi

echo "→ preflight (model + dependency check)"
node scripts/preflight.mjs || echo "  …continuing; missing pieces just degrade gracefully."

[ -d node_modules ] || { echo "→ installing API deps"; npm install; }
[ -d web/node_modules ] || { echo "→ installing web deps"; (cd web && npm install); }

if [ ! -f data/icd10.index.bin ]; then
  echo "→ building ICD-10 index (one-time, ~1 min)"; npm run build-icd-index
fi

pids=()
cleanup() { echo; echo "stopping…"; for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "→ API server (:8787) — loads + warms STT/TTS, ~10-15 s"
node src/server.js & pids+=($!)
for i in $(seq 1 60); do curl -s http://localhost:8787/api/health >/dev/null 2>&1 && break; sleep 1; done

echo "→ web kiosk (Vite) — open the printed URL"
(cd web && npm run dev) & pids+=($!)

wait
