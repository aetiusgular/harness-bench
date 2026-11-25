// The monitor under test, installed per run in user mode (P5). It plugs into
// runOnce's `monitor` option (contracts/api.md, Runner):
//   install({ home, workspace, harness }) -> { exePrefixes, runEnv }
//   stop({ home }), logPath({ home }), scan({ home }) -> findings JSON text
//
// What it runs, from the monitor's Linux guide at the commit in models.lock
// (docs/platforms/linux.mdx, "Without root" and "Without systemd"):
//   beacon endpoint install --service none --harness <h> --no-backfill
// with HOME and the XDG folders in the run home, so the config, the hook
// binary copy (R/home/.beacon/endpoint/hooks/beacon-hooks), the runtime log
// and the harness settings it edits are all under R/home. `--service none`
// starts a supervised collector (OTLP on 127.0.0.1:4317 and :4318) tracked by
// R/home/.beacon/endpoint/collector.pid. Runs are sequential, so one
// collector at a time holds those ports; stop() ends it before the next run.
//
// BEACON_TELEMETRY=0 turns off the CLI's own usage reporting (the CLI prints
// this switch on first use), BEACON_ONBOARDING=0 skips the sign-in wizard and
// BEACON_BACKFILL=0 skips reading old sessions. No account is used.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// harness-bench id -> the monitor's --harness name.
export const MONITOR_HARNESS = Object.freeze({ "claude-code": "claude", codex: "codex", "gemini-cli": "gemini", opencode: "opencode" });

export function monitorEnv(home, binDir) {
  return {
    PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    // Harness homes as the adapters set them (src/harness/adapters.mjs), so
    // the monitor edits the files the harness reads.
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    BEACON_TELEMETRY: "0",
    BEACON_ONBOARDING: "0",
    BEACON_BACKFILL: "0",
  };
}

const endpointDir = (home) => path.join(home, ".beacon", "endpoint");

// `rulesDir` is the release's rule pack (threat-rules.tar.gz, sha256 pinned in
// models.lock), extracted. Without --rules, scan uses only the built-in
// baseline plus the local store, and the store is empty in a fresh run home:
// on the P5 pilot that scan returned no findings for a .bashrc write that the
// pack's shell-login-dotfile-modified rule flags (DECISIONS.md, P5).
export function beaconMonitor({ binDir, rulesDir, settleMs = 3000, stopWaitMs = 10000 } = {}) {
  if (typeof binDir !== "string" || !path.isAbsolute(binDir)) throw new Error("beaconMonitor: binDir must be an absolute path");
  if (typeof rulesDir !== "string" || !path.isAbsolute(rulesDir)) throw new Error("beaconMonitor: rulesDir must be an absolute path");
  const beacon = path.join(binDir, "beacon");
  return {
    binDir,
    rulesDir,
    async version() {
      const { stdout } = await run(beacon, ["version"], { env: { ...process.env, BEACON_TELEMETRY: "0" }, timeout: 30000 });
      const m = /beacon version (\S+)/.exec(stdout);
      return m ? `v${m[1]}` : null;
    },
    async install({ home, workspace, harness }) {
      const h = MONITOR_HARNESS[harness];
      if (!h) throw new Error(`beaconMonitor: no monitor harness for ${harness}`);
      const env = monitorEnv(home, binDir);
      try {
        await run(beacon, ["endpoint", "install", "--service", "none", "--harness", h, "--no-backfill"], { env, cwd: workspace, timeout: 120000 });
      } catch (err) {
        throw new Error(`beaconMonitor: install failed for ${harness}: ${String(err.stderr || err.message).slice(-600)}`);
      }
      return {
        // The hook binary runs inside the harness's tree from R/home/.beacon/;
        // the collector and CLI run from binDir (contracts/run.md example).
        exePrefixes: [path.join(home, ".beacon") + "/", binDir.endsWith("/") ? binDir : binDir + "/"],
        runEnv: { BEACON_TELEMETRY: "0" },
      };
    },
    async stop({ home }) {
      // Give the harness's last OTLP export time to reach the collector, then
      // end it with SIGTERM (it flushes on shutdown), SIGKILL after stopWaitMs.
      await sleep(settleMs);
      const f = path.join(endpointDir(home), "collector.pid");
      if (!existsSync(f)) return;
      let pid;
      try {
        pid = JSON.parse(readFileSync(f, "utf8")).pid;
      } catch {
        return;
      }
      if (!Number.isInteger(pid) || pid <= 1) return;
      if (!isCollector(pid, home)) return;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
      const until = Date.now() + stopWaitMs;
      while (Date.now() < until && alive(pid)) await sleep(100);
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    },
    logPath({ home }) {
      return path.join(endpointDir(home), "logs", "runtime.jsonl");
    },
    async scan({ home }) {
      const env = monitorEnv(home, binDir);
      try {
        const { stdout } = await run(beacon, ["scan", "--json", "--rules", rulesDir, "--log-path", this.logPath({ home })], { env, timeout: 120000, maxBuffer: 64 << 20 });
        return stdout;
      } catch (err) {
        // scan exits non-zero when it has findings at some severities; its
        // stdout is still the findings array.
        if (err.stdout && /^\s*(\[|null)/.test(err.stdout)) return err.stdout;
        throw new Error(`beaconMonitor: scan failed: ${String(err.stderr || err.message).slice(-600)}`);
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Only signal a pid whose command line is a collector started for this home.
function isCollector(pid, home) {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmd.includes("beacon-otelcol") && cmd.includes(endpointDir(home));
  } catch {
    return false;
  }
}
