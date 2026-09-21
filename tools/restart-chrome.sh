#!/usr/bin/env bash
# Restart the test Chrome with ProxyDeck freshly loaded from disk.
#
# Usage:
#   bash tools/restart-chrome.sh                          # load the working tree
#   EXT_DIR=/path/to/unzipped bash tools/restart-chrome.sh  # load an extracted ZIP
#
# Traps this script avoids (each cost real debugging time):
#  1. Chrome 137+ BLOCKS --load-extension in regular Chrome. We use Chrome for
#     Testing (installed via `npx @puppeteer/browsers install chrome@stable`).
#  2. A leftover Chrome holding the debug port makes CDP attach to the OLD
#     browser, so code changes appear not to apply. Kill all, wait for the port.
#  3. Reusing a profile dir serves CACHED extension files — always a fresh dir.
#  4. An occluded window reports visibilityState "hidden" and Chrome SILENTLY
#     DROPS every CDP input event, which looks exactly like an extension bug.
set -e
PORT="${CDP_PORT:-9335}"
EXT="${EXT_DIR:-D:/new project/extention/proxy}"
CFT="${CHROME_BIN:-$LOCALAPPDATA/Temp/cft/chrome/win64-153.0.8010.52/chrome-win64/chrome.exe}"
PROF="$LOCALAPPDATA/Temp/pd-prof-$$-$(date +%s)"

taskkill -F -IM chrome.exe -T >/dev/null 2>&1 || true
# NOTE: use SINGLE-dash flags. MSYS bash mangles the //F //IM form ("Invalid
# argument/option - '//F'"), the kill silently fails, the old Chrome keeps the
# debug port, and CDP then drives the PREVIOUS browser with stale storage —
# which looks exactly like an extension bug (leftover profiles, wrong counts).
for i in $(seq 1 20); do
  curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || break
  sleep 1
done
if curl -s -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "ERROR: port $PORT still held by another Chrome" >&2
  exit 1
fi

mkdir -p "$PROF"
"$CFT" --remote-debugging-port="$PORT" --user-data-dir="$PROF" \
  --disable-extensions-except="$EXT" --load-extension="$EXT" \
  --no-first-run --no-default-browser-check --enable-automation --test-type \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --window-size=1280,900 --window-position=0,0 \
  "about:blank" >/dev/null 2>&1 &

for i in $(seq 1 25); do
  sleep 1
  if curl -s -m 1 "http://127.0.0.1:$PORT/json/list" >/dev/null 2>&1; then
    echo "chrome ready on $PORT"
    echo "  extension: $EXT"
    echo "  profile  : $PROF"
    exit 0
  fi
done
echo "ERROR: chrome did not come up on $PORT" >&2
exit 1
