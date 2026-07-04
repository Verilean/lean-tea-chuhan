#!/usr/bin/env bash
# Playwright button smoke test. Auto-plays the running server in a real
# headless Chromium, clicking every button, and fails on any runtime
# error. The runtime complement to the boot-time auditButtons check.
#
#   bash ChuHan/e2e.sh                      # against a server on :8090
#   CHUHAN_URL=http://127.0.0.1:8091/ bash ChuHan/e2e.sh
#
# Needs the Playwright bridge from lean-elm (LEANTEA_DIR / the git dep):
# override its path with LEANTEA_BROWSER_BRIDGE if autodetection misses.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CHUHAN_URL:=http://127.0.0.1:8090/}"
: "${LEANTEA_BROWSER_HEADLESS:=1}"

# Locate the browser bridge: explicit override → LEANTEA_DIR → the git dep.
if [[ -z "${LEANTEA_BROWSER_BRIDGE:-}" ]]; then
  for cand in \
    "${LEANTEA_DIR:-}/tools/browser-bridge/bridge.js" \
    ".lake/packages/lean-tea/tools/browser-bridge/bridge.js"; do
    if [[ -n "$cand" && -f "$cand" ]]; then LEANTEA_BROWSER_BRIDGE="$cand"; break; fi
  done
fi

export CHUHAN_URL LEANTEA_BROWSER_HEADLESS LEANTEA_BROWSER_BRIDGE
lake build chuhan_e2e >/dev/null
exec ./.lake/build/bin/chuhan_e2e
