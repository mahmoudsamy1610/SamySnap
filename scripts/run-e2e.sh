#!/usr/bin/env bash
# Runs the browser e2e tests. Headed Chrome is required (the native screen
# picker doesn't exist in headless mode), so on a Linux box without a display
# we start a virtual one with xvfb-run.
set -euo pipefail
cd "$(dirname "$0")/.."
CMD=(node --test --test-concurrency=1 "tests/e2e/**/*.test.js")
if [[ "$(uname)" == "Linux" && -z "${DISPLAY:-}" ]] && command -v xvfb-run >/dev/null; then
  exec xvfb-run -a -s "-screen 0 1920x1080x24" "${CMD[@]}"
fi
exec "${CMD[@]}"
