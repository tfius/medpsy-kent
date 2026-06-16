#!/usr/bin/env bash
# Stage the live demo (see DEMO_SCRIPT.md): two meshed kiosks + web, with the Signals scene
# pre-seeded JUST BELOW threshold (one on-camera click crosses it) and one agentic triage pre-run
# so its audit timeline is ready. Idempotent — re-run between takes. Needs the LLM backend up
# (LM Studio on :1234, or set MEDPSY_BACKEND=qvac). Run from qvac-app/:  bash scripts/demo_stage.sh
set -u
cd "$(dirname "$0")/.."
PAIR_A="citalopram"; PAIR_B="domperidone"   # the Signals page's default watch pair

echo "→ stopping any running kiosks/web…"
pkill -f "node src/server.js" 2>/dev/null
for p in 8787 8788; do pid=$(lsof -ti tcp:$p 2>/dev/null); [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
sleep 1

echo "→ wiping demo profiles for a CLEAN slate (so the Signals scene crosses fresh on camera)…"
rm -rf data/profiles/demoA data/profiles/demoB

echo "→ starting Kiosk A (8787) + Kiosk B (8788), shared code DEMO…"
MEDPSY_NO_SPEECH=1 nohup npm run kiosk -- --profile demoA --port 8787 --consult-code DEMO > /tmp/demoA.log 2>&1 &
MEDPSY_NO_SPEECH=1 nohup npm run kiosk -- --profile demoB --port 8788 --consult-code DEMO > /tmp/demoB.log 2>&1 &
for u in 8787 8788; do for i in $(seq 1 90); do curl -s -m2 "http://localhost:$u/api/health" >/dev/null 2>&1 && break; sleep 1; done; done
echo "  kiosks up."

echo "→ waiting for the mesh to form…"
for i in $(seq 1 15); do
  a=$(curl -s -m3 http://localhost:8787/api/kb 2>/dev/null | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["peers"]))' 2>/dev/null)
  [ "$a" = "1" ] && { echo "  meshed (A↔B)."; break; }; sleep 2
done

echo "→ pre-seeding Signals JUST BELOW threshold ($PAIR_A + $PAIR_B): A=1 flagged, B=1 flagged…"
curl -s -m10 -X POST http://localhost:8787/api/signals/observe -H 'content-type: application/json' -d "{\"a\":\"$PAIR_A\",\"b\":\"$PAIR_B\",\"adverse\":true}" >/dev/null
curl -s -m10 -X POST http://localhost:8788/api/signals/observe -H 'content-type: application/json' -d "{\"a\":\"$PAIR_A\",\"b\":\"$PAIR_B\",\"adverse\":true}" >/dev/null
sleep 3
echo "  network total now: $(curl -s http://localhost:8787/api/signals | python3 -c 'import sys,json;d=json.load(sys.stdin);r=(d.get("aggregate") or [{}])[0];print(f"{r.get(\"flagged\",0)} flagged / {r.get(\"seen\",0)} seen across {r.get(\"contributors\",0)} kiosks — crossing now: {len(d.get(\"crossing\",[]))>0}")' 2>/dev/null)"
echo "  (on camera: one ⚠️ +concern on Kiosk A → 3 flagged → crosses.)"

echo "→ pre-running one agentic triage (EMERGENCY) so the Audit timeline is ready (~30-60s)…"
curl -s -m 120 -N -X POST http://localhost:8787/api/agentic-triage -H 'content-type: application/json' \
  -d '{"encounterId":"demo-acs","reset":true,"message":"58-year-old man, 40 minutes of crushing central chest pain spreading to the left arm and jaw, sweaty and nauseous, not eased by rest. (Complete case — give your triage conclusion now.)"}' \
  | grep -o '"type":"conclusion"' | head -1 >/dev/null && echo "  audit ready (encounter demo-acs)." || echo "  (triage pre-run skipped/slow — you can run Scene 3 against any prior encounter)."

WEBPORT=""
if ! lsof -ti tcp:5174 >/dev/null 2>&1; then
  echo "→ starting web…"
  ( cd web && nohup npm run dev > /tmp/demoweb.log 2>&1 & )
  sleep 4
fi
WEBPORT=$(grep -oaE "localhost:[0-9]+" /tmp/demoweb.log 2>/dev/null | head -1)
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  STAGED. Open the kiosk:  http://${WEBPORT:-localhost:5174}/"
echo "  Demo order: 📊 Trust → 🕸 Mesh → 📡 Signals → 🛡 Audit (encounter demo-acs)"
echo "  Follow DEMO_SCRIPT.md. Re-run this script between takes to reset."
echo "  When done:  pkill -f 'node src/server.js'  (and stop the web dev server)"
echo "════════════════════════════════════════════════════════════════"
