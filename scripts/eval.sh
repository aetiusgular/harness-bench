#!/usr/bin/env bash
# The single entry point the box runs (BUILD_OUTLINE.md sections 6 and 8).
# forge's eval workflow runs it inside srt with the network limited to
# 127.0.0.1, from the repo root, with FORGE_REPO, FORGE_PR, FORGE_SHA,
# FORGE_PHASE and FORGE_MACHINE_FILE (machine labels read on the host at run
# time) in the environment. It writes results/*.jsonl rows (results/README.md)
# and results/summary.md, which becomes the PR comment.
#
# P5. Before it runs, on the host (the sandbox has no outside network):
#   - scripts/p5-setup.sh "$HB_PREFIX" has installed the pinned CLIs and monitor;
#   - contracts/audit.rules.template is loaded for the run account, and
#     auditd's log_group is a group of that account (contracts/run.md).
# scripts/eval.mjs checks both and exits 3 when the rules are missing.
#
# Columns (eval_boundary landlock). forge's queue.json lists `srt` in
# columns_outside_landrun for this project, so forge/sandbox/run-eval.sh runs
# this script twice: a landrun pass with FORGE_SKIP_COLUMNS=srt, then the
# `srt` column (FORGE_COLUMN=srt) under `derm run --boundary srt`. Every stage
# needs the monitor's collector on 127.0.0.1:4317/4318, which landrun's TCP
# rules do not open (SPEC.md, Risks), so the landrun pass runs nothing and
# says so; the srt column runs everything with boundary `srt`
# (HB-P5-r1-C2). With no column set (a local run), everything runs.
#
# Project dependencies (package-lock.json, derm-workspace). The box checks out
# a fresh tree with no node_modules and the sandbox has no outside network,
# so scripts/p5-setup.sh installs them on the host into <prefix>/deps, and
# this script links node_modules to that copy when the lockfiles match. It
# exits 3 when they are missing or stale (HB-P5-r1-C1).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${FORGE_PHASE:-}" != "P5" && "${FORGE_PHASE:-}" != "P6" ]]; then
  echo "not an eval phase"
  exit 0
fi
if [[ ",${FORGE_SKIP_COLUMNS:-}," == *",srt,"* ]]; then
  echo "eval: this pass is skipped; every stage runs in the srt column (FORGE_COLUMN=srt), where the monitor's collector ports are reachable" | tee results/summary.md
  exit 0
fi
if [[ -n "${FORGE_COLUMN:-}" && "${FORGE_COLUMN}" != "srt" ]]; then
  echo "eval: no column ${FORGE_COLUMN} in this project (its one column is srt)" >&2
  exit 2
fi
prefix="${HB_PREFIX:-$HOME/.cache/harness-bench/p5}"
if [[ ! -e node_modules/derm-workspace/package.json ]]; then
  deps="$prefix/deps"
  if [[ ! -e "$deps/node_modules/derm-workspace/package.json" ]] || ! cmp -s package-lock.json "$deps/package-lock.json"; then
    echo "eval: project dependencies are not installed for this package-lock.json; run scripts/p5-setup.sh $prefix on the host first" >&2
    exit 3
  fi
  # HB-P5-r2-C1: a real node_modules folder without derm-workspace (a partial
  # install) would take the link inside it as node_modules/node_modules.
  if [[ -e node_modules && ! -L node_modules ]]; then
    echo "eval: node_modules is a folder without derm-workspace; remove it or run npm ci" >&2
    exit 3
  fi
  rm -f node_modules
  ln -s "$deps/node_modules" node_modules
fi
export HB_TMP="${HB_TMP:-/tmp}"
export HB_BOUNDARY="${HB_BOUNDARY:-${FORGE_COLUMN:-landlock}}"
exec node scripts/eval.mjs --prefix "$prefix" --stage "${HB_STAGES:-calibration,E0,E1-dev}"
