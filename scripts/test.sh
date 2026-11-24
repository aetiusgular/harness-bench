#!/usr/bin/env bash
# Project tests and lint (ci). Red tests are not run here: forge-gate runs
# them from tests/red/manifest.json and expects each to fail until its lane.
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s globstar nullglob
# Lint: every module parses.
for f in src/**/*.mjs tests/**/*.mjs scripts/*.mjs; do node --check "$f"; done
node tests/red/build-manifest.mjs --check
files=(tests/contract/*.test.mjs tests/model/**/*.test.mjs tests/truth/**/*.test.mjs tests/score/**/*.test.mjs)
node --test "${files[@]}"
