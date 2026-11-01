#!/bin/zsh
# Runs the env-gated live UI tests against a fresh `dev:local` API on :8807.
# Usage: PraxisChat/scripts/run-live-ui.sh [simulator name] [derived data]
emulate -L zsh
set -euo pipefail
here=${0:A:h}; repo=${here:h:h}
sim=${1:-Cloud-C}; dd=${2:-/tmp/praxis-cloud-dd/C}
slot=~/.praxis-agent-state/cloud/tools/slot.sh
stop() { lsof -ti tcp:8807 -sTCP:LISTEN | xargs kill 2>/dev/null || true }
stop
(cd "$repo/cloud" && PORT=8807 npm run dev:local > /tmp/praxis-live-8807.log 2>&1) &
trap stop EXIT
for _ in {1..60}; do curl -sf http://127.0.0.1:8807/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:8807/health >/dev/null || { echo "dev:local did not start; see /tmp/praxis-live-8807.log" >&2; exit 1 }
cmd=(xcodebuild test -project "$repo/PraxisChat/PraxisChat.xcodeproj" -scheme PraxisChat
     -destination "platform=iOS Simulator,name=$sim" -derivedDataPath "$dd" -parallel-testing-enabled NO
     -only-testing:PraxisChatUITests/CloudWalkthroughUITests)
if [[ -x $slot ]]; then TEST_RUNNER_PRAXIS_LIVE_API=http://127.0.0.1:8807 $slot ${PRAXIS_SLOT_OWNER:-live-ui} $cmd
else TEST_RUNNER_PRAXIS_LIVE_API=http://127.0.0.1:8807 $cmd; fi
