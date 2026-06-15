#!/usr/bin/env bash
# Two-kiosk FEDERATED-LEARNING demo: start Kiosk A (:8787) and Kiosk B (:8788) as separate
# kiosks (own KB / facts / audit / device key), pair them (B replicates A's graph), and serve
# the web. Then open the "🔗 2-Kiosk" page: teach a missed interaction on A, watch B's agent
# start catching it — only drug names cross between the devices, no server.
#
#   (start LM Studio on :1234 — medpsy-4b + the embeddings model — then:)
#   npm run demo:two-kiosk
set -uo pipefail
cd "$(dirname "$0")/.."
TMP="${TMPDIR:-/tmp}/medpsy-2kiosk-$$"; mkdir -p "$TMP"
CODE="DEMO-FED"
echo "→ two-kiosk federated-learning demo — Kiosk A :8787, Kiosk B :8788, consult code $CODE"

[ -d node_modules ] || npm install
[ -d web/node_modules ] || (cd web && npm install)
[ -f data/icd10.index.bin ] || { echo "→ building ICD-10 index (one-time)"; npm run build-icd-index; }

pids=()
cleanup(){ echo; echo "stopping…"; for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

start_kiosk(){ # name port
  local name=$1 port=$2
  API_PORT=$port MEDPSY_NO_SPEECH=1 MEDPSY_CONSULT_CODE="$CODE" \
  MEDPSY_KB_DIR="$TMP/$name/kb" MEDPSY_FACTS_DIR="$TMP/$name/facts" MEDPSY_AUDIT_DIR="$TMP/$name/audit" \
  MEDPSY_DEVICE_KEY_FILE="$TMP/$name/device-key.json" MEDPSY_DEVICE_NAME="Kiosk-$name" \
  node src/server.js > "$TMP/$name.log" 2>&1 &
  pids+=($!)
}
echo "→ starting Kiosk A + Kiosk B"; start_kiosk A 8787; start_kiosk B 8788
for u in 8787 8788; do for i in $(seq 1 60); do curl -s "http://localhost:$u/api/health" >/dev/null 2>&1 && break; sleep 1; done; done

echo "→ kiosks on the same consult code AUTO-MESH (bidirectional, no pairing) — ~20 s to connect."
echo "  (add more kiosks any time: API_PORT=8789 MEDPSY_CONSULT_CODE=$CODE … node src/server.js — they auto-join.)"
# A quick manual kick so the demo doesn't wait for discovery (idempotent with the auto-mesh).
KEY=$(curl -s -X POST http://localhost:8787/api/kb/share | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).key)}catch{console.log("")}})')
[ -n "$KEY" ] && curl -s -X POST http://localhost:8788/api/kb/join -H 'content-type: application/json' -d "{\"key\":\"$KEY\"}" >/dev/null && echo "  kicked B→A (auto-mesh will also link A→B)"

echo "→ starting web…"
(cd web && VITE_API_URL=http://localhost:8787 npm run dev) & pids+=($!)
echo
echo "✅ Open the printed Vite URL → '🔗 2-Kiosk'. A=http://localhost:8787  B=http://localhost:8788"
echo "   Teach on A, watch Kiosk B flip NO → YES. (Logs: $TMP/{A,B}.log)"
wait
