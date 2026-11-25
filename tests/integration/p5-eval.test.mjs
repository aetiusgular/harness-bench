// P5 tests: startup exclusions from calibration runs, band and write-path
// aggregation, the summary, the monitor hook (against a stand-in `beacon`),
// the runner's install order, and reading across one audit log rotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startupExclusions, toVars } from "../../src/eval/startup.mjs";
import { aggregate, bandId } from "../../src/eval/aggregate.mjs";
import { summarize } from "../../src/eval/summary.mjs";
import { beaconMonitor, MONITOR_HARNESS } from "../../src/monitor/beacon.mjs";
import { runOnce, readAuditLog, firstStamp } from "../../src/run/runner.mjs";
import { makeRow } from "../../src/score/rows.mjs";
import { scenarios } from "./lib.mjs";

const tmpdir = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "hb-p5-")));
const V = (root) => ({ WS: `${root}/ws`, HOME: `${root}/home`, OUT: `${root}/out` });

test("startup exclusions: run-varying names widen to a folder seen in every run; shallow files stay exact", () => {
  const runs = [1, 2, 3].map((k) => {
    const vars = V(`/tmp/hb-r${k}`);
    return {
      vars,
      paths: [
        `${vars.HOME}/.claude/.claude.json.tmp.${k}00.ab${k}`,
        `${vars.HOME}/.claude/projects/-tmp-hb-r${k}-ws/s${k}.jsonl`,
        `/tmp/claude-1000/fswatch-probe-${k}x/probe`,
        `/tmp/cc-socks-1000/${k}.sock`,
        `${vars.HOME}/.claude.json`,
        `${vars.WS}/inside.txt`,
      ],
    };
  });
  const { paths, refused } = startupExclusions(runs, { expect: ["${HOME}/.bashrc"], tmpRoot: "/tmp" });
  assert.deepEqual(paths, ["${HOME}/.claude.json", "${HOME}/.claude/", "/tmp/cc-socks-1000/", "/tmp/claude-1000/"]);
  assert.deepEqual(refused, []);
  assert.equal(toVars("/tmp/hb-r1/home/x", V("/tmp/hb-r1")), "${HOME}/x");
});

test("startup exclusions refuse an entry that covers an expected write or the run root's parent", () => {
  const vars = V("/tmp/s/hb-r1");
  const runs = [{ vars, paths: [`${vars.HOME}/.config/autostart/x.desktop`, `/tmp/s/stray.lock`, `/tmp/s2/f`] }];
  const { paths, refused } = startupExclusions(runs, { expect: ["${HOME}/.config/autostart/hb.desktop"], tmpRoot: "/tmp/s" });
  assert.deepEqual(paths, ["/tmp/s2/"]);
  const why = Object.fromEntries(refused.map((r) => [r.path, r.reason]));
  assert.deepEqual(Object.keys(why).sort(), ["${HOME}/.config/autostart/", "/tmp/s/"]);
  assert.match(why["${HOME}/.config/autostart/"], /covers expected write/);
  assert.match(why["/tmp/s/"], /run root's parent/);
});

const META = { git_sha: "x", machine: "m", model_revision: "h", quant: null, runtime: "node", date: "2026-11-25T00:00:00Z", stage: "E1-dev" };
const head = (o) => makeRow("headline", { ...META, run_id: o.id, harness: "codex", cli_version: "0.172.0", monitor_version: "v1.3.67", split: "dev", scenario_count: 1, scenario: o.sc, matcher: "contract", numerator: o.n, denominator: o.d, rate: o.d ? o.n / o.d : null, excluded: { monitor: 0, model_server: 0, startup: 0 }, other: { other_syscall: 0, openat2_unclassified: 0, denied: 0, unresolved: 0 }, in_workspace: 0, missed: [], repeat: o.k, write_path: o.wp, unsupported_step: !!o.un });

test("aggregate: per-repeat sums, a band over repeats, write-path rows without unsupported scenarios, dropped runs named", () => {
  const rows = [
    head({ id: "a1", sc: "s1", n: 1, d: 2, k: 1, wp: "shell" }),
    head({ id: "b1", sc: "s2", n: 0, d: 1, k: 1, wp: "edit", un: true }),
    head({ id: "a2", sc: "s1", n: 2, d: 2, k: 2, wp: "shell" }),
    head({ id: "b2", sc: "s2", n: 0, d: 1, k: 2, wp: "edit", un: true }),
    head({ id: "a3", sc: "s1", n: 0, d: 2, k: 3, wp: "shell" }),
  ];
  const { bands, writePaths } = aggregate(rows, { meta: META, scenarioCount: 2, dropped: ["a3"] });
  assert.equal(bands.length, 1);
  const b = bands[0];
  assert.deepEqual([b.numerator, b.denominator, b.repeats, b.dropped_runs], [[1, 2], [3, 3], [1, 2], ["a3"]]);
  assert.deepEqual(b.band, { min: 1 / 3, median: 0.5, max: 2 / 3, n: 2 });
  assert.equal(b.run_id, bandId("codex", "dev", "contract", ["a1", "a2", "b1", "b2"]));
  const edit = writePaths.filter((w) => w.write_path === "edit");
  assert.deepEqual(edit.map((w) => [w.numerator, w.denominator, w.rate, w.unsupported_scenarios]), [[0, 0, null, ["s2"]], [0, 0, null, ["s2"]]]);
  const md = summarize({ pilot: true, out: "results/x.jsonl", monitorVersion: "v1.3.67", auditRules: "host:k", boundary: "none", calibration: null, stages: [{ stage: "E1-dev", split: "dev", rows, bands, writePaths, dropped: ["a3"] }] });
  assert.match(md, /not the measured run/);
  assert.match(md, /\| codex \| 0\.172\.0 \| contract \| 33\.3% \/ 50\.0% \/ 66\.7% \(n=2\) \| 1, 2 \/ 3, 3 \|/);
  assert.match(md, /\| codex \| edit \| 0 \/ 0 \| s2 \|/);
});

test("aggregate gives no band, never 100%, when every repeat has nothing to capture", () => {
  const { bands } = aggregate([head({ id: "z", sc: "s", n: 0, d: 0, k: 1, wp: "control" })], { meta: META, scenarioCount: 1 });
  assert.equal(bands[0].band, null);
});

// A stand-in `beacon` CLI: `endpoint install` appends to the Codex config and
// starts a stand-in collector; `scan` prints a findings array.
function fakeBeacon(dir) {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "beacon-otelcol"), "#!/bin/sh\nwhile :; do sleep 0.1; done\n", { mode: 0o755 });
  writeFileSync(
    path.join(bin, "beacon"),
    `#!/bin/sh
case "$1 $2" in
  "version "*) echo "beacon version 1.3.67 (x)";;
  "endpoint install")
    d="$HOME/.beacon/endpoint"; mkdir -p "$d/logs" "$CODEX_HOME"
    printf '[otel]\\n' >> "$CODEX_HOME/config.toml"
    printf '%s\\n' "$*" > "$d/args"
    "${bin}/beacon-otelcol" "$d/otelcol.yaml" >/dev/null 2>&1 &
    printf '{"pid": %s}\\n' "$!" > "$d/collector.pid"
    echo '{"timestamp":"2026-11-25T00:00:00Z","sequence":1,"event":{"action":"telemetry.enabled"}}' > "$d/logs/runtime.jsonl";;
  "scan --json") echo '[]';;
esac
`,
    { mode: 0o755 },
  );
  return bin;
}

test("beaconMonitor installs in the run home after the adapter's config, and stop ends only its collector", async () => {
  const tmp = tmpdir();
  try {
    const binDir = fakeBeacon(tmp);
    const rulesDir = path.join(tmp, "rules");
    mkdirSync(rulesDir);
    const mon = beaconMonitor({ binDir, rulesDir, settleMs: 10 });
    assert.equal(await mon.version(), "v1.3.67");
    assert.deepEqual(Object.keys(MONITOR_HARNESS).sort(), ["claude-code", "codex", "gemini-cli", "opencode"]);
    const cli = path.join(tmp, "cli.sh");
    writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const sc = scenarios("dev").find((s) => s.id === "control-edit");
    const seen = {};
    const wrapped = {
      ...mon,
      install: async (o) => {
        seen.adapterConfigFirst = existsSync(path.join(o.home, ".codex", "config.toml"));
        return mon.install(o);
      },
      stop: async (o) => {
        const pid = JSON.parse(readFileSync(path.join(o.home, ".beacon/endpoint/collector.pid"), "utf8")).pid;
        await mon.stop(o);
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        seen.collectorStopped = !alive;
      },
      logPath: (o) => mon.logPath(o),
    };
    const r = await runOnce({ harness: "codex", scenario: sc, bin: cli, tmp, monitor: wrapped, timeoutMs: 20000 });
    assert.equal(r.status, 0);
    assert.equal(seen.adapterConfigFirst, true);
    assert.equal(seen.collectorStopped, true);
    const cfg = readFileSync(path.join(r.vars.HOME, ".codex", "config.toml"), "utf8");
    assert.match(cfg, /model_provider = "hb"[\s\S]*\[otel\]/); // the monitor's settings were merged after the adapter's, not overwritten
    assert.match(readFileSync(path.join(r.vars.HOME, ".beacon/endpoint/args"), "utf8"), /--service none --harness codex --no-backfill/);
    assert.deepEqual(r.run.exclude.monitor_exe_prefixes, [path.join(r.vars.HOME, ".beacon") + "/", binDir + "/"]);
    assert.ok(existsSync(r.monitorLog));
    assert.equal(await mon.scan({ home: r.vars.HOME }), "[]\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readAuditLog reads <file>.1 first when the window starts before the current file", () => {
  const tmp = tmpdir();
  try {
    const f = path.join(tmp, "audit.log");
    writeFileSync(`${f}.1`, "type=SYSCALL msg=audit(100.000:1): a\n");
    writeFileSync(f, "type=SYSCALL msg=audit(200.000:2): b\n");
    assert.equal(firstStamp(readAuditLog(f, { since: 150 })), 100);
    assert.equal(firstStamp(readAuditLog(f, { since: 250 })), 200);
    assert.equal(firstStamp(readAuditLog(f)), 200);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
