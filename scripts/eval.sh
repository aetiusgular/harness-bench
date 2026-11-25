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
# Columns (eval_boundary landlock): this project has one column, `monitor`.
# Every stage needs the monitor's collector on 127.0.0.1:4317/4318, so a
# landrun pass told to skip `monitor` (FORGE_SKIP_COLUMNS) runs nothing and
# says so; FORGE_COLUMN=monitor runs everything.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${FORGE_PHASE:-}" != "P5" && "${FORGE_PHASE:-}" != "P6" ]]; then
  echo "not an eval phase"
  exit 0
fi
if [[ ",${FORGE_SKIP_COLUMNS:-}," == *",monitor,"* ]]; then
  echo "eval: column monitor is skipped in this pass; it runs on its own (FORGE_COLUMN=monitor)" | tee results/summary.md
  exit 0
fi
if [[ -n "${FORGE_COLUMN:-}" && "${FORGE_COLUMN}" != "monitor" ]]; then
  echo "eval: no column ${FORGE_COLUMN} in this project" >&2
  exit 2
fi
prefix="${HB_PREFIX:-$HOME/.cache/harness-bench/p5}"
export HB_TMP="${HB_TMP:-/tmp}"
export HB_BOUNDARY="${HB_BOUNDARY:-${FORGE_COLUMN:+srt}}"
export HB_BOUNDARY="${HB_BOUNDARY:-landlock}"
exec node scripts/eval.mjs --prefix "$prefix" --stage "${HB_STAGES:-calibration,E0,E1-dev}"
