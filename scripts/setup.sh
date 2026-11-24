#!/usr/bin/env bash
# Project setup (ci runs it before scripts/test.sh and the phase gate).
# Installs the one pinned dependency (derm, for its fake model servers;
# package-lock.json). No install scripts run. The harness CLIs are not
# installed here; scripts/p2-keyless-smoke.mjs and P5 install them from
# models.lock.
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --ignore-scripts --no-audit --no-fund
