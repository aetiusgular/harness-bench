#!/usr/bin/env bash
# P5: install the pinned tools the eval runs, on the host, before the eval's
# sandbox starts (the sandbox's network is 127.0.0.1 only). Nothing here is
# vendored into the repo. Re-running it is safe.
#
#   scripts/p5-setup.sh [prefix]      (default $HOME/.cache/harness-bench/p5)
#
# Layout (scripts/eval.mjs reads it):
#   <prefix>/cli/node_modules/.bin/{claude,codex,gemini,opencode}   models.lock versions, npm, --ignore-scripts
#   <prefix>/beacon/bin/{beacon,beacon-hooks,beacon-otelcol,beacon-vector}
#   <prefix>/beacon/threat-rules.tar.gz, <prefix>/beacon/rules/rules/
#   <prefix>/deps/{package.json,package-lock.json,node_modules}   this repo's own
#       dependencies (derm-workspace), npm ci --ignore-scripts; scripts/eval.sh
#       links node_modules to it when the lockfiles match (HB-P5-r1-C1)
set -euo pipefail
cd "$(dirname "$0")/.."
prefix="${1:-$HOME/.cache/harness-bench/p5}"
lock=models.lock
mkdir -p "$prefix/cli" "$prefix/beacon" "$prefix/deps"

cp package.json package-lock.json "$prefix/deps/"
(cd "$prefix/deps" && npm ci --no-fund --no-audit --ignore-scripts >/dev/null)

pkgs=()
while read -r npm ver; do pkgs+=("$npm@$ver"); done < <(jq -r '.harnesses[] | "\(.npm) \(.version)"' "$lock")
(
  cd "$prefix/cli"
  [[ -f package.json ]] || npm init -y >/dev/null
  npm install --no-fund --no-audit --ignore-scripts "${pkgs[@]}" >/dev/null
)

rel=$(jq -r '.monitor.release' "$lock"); ver=${rel#v}
src=$(jq -r '.monitor.source' "$lock")
archive=$(jq -r '.monitor.archive' "$lock")
cd "$prefix/beacon"
base="$src/releases/download/$rel"
curl -fsSLO "$base/$archive"
curl -fsSLO "$base/checksums.txt"
grep "  ${archive}\$" checksums.txt | sha256sum --check -
[[ "$(sha256sum "$archive" | cut -d' ' -f1)" == "$(jq -r '.monitor.archive_sha256' "$OLDPWD/$lock")" ]] || { echo "p5-setup: $archive does not match models.lock" >&2; exit 1; }
mkdir -p bin && tar -xzf "$archive" -C bin
curl -fsSLO "$base/threat-rules.tar.gz"
[[ "$(sha256sum threat-rules.tar.gz | cut -d' ' -f1)" == "$(jq -r '.monitor.rules_sha256' "$OLDPWD/$lock")" ]] || { echo "p5-setup: threat-rules.tar.gz does not match models.lock" >&2; exit 1; }
rm -rf rules && mkdir -p rules && tar -xzf threat-rules.tar.gz -C rules
BEACON_TELEMETRY=0 bin/beacon version | grep -q "beacon version $ver " || { echo "p5-setup: beacon is not $rel" >&2; exit 1; }
echo "p5-setup: tools in $prefix"
