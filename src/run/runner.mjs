// The runner (contracts/run.md, contracts/api.md "Runner"): lays out one run,
// starts the scripted server, spawns the harness through its adapter, records
// the audit window, writes R/run.json, and scores a finished run into
// results rows. P4. The monitor install and scripts/eval.sh are P5; they plug
// in through the `monitor` option and `scoreRun`'s inputs.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../model/server.mjs";
import { substitute } from "../model/vars.mjs";
import { adapterFor } from "../harness/adapters.mjs";
import { collectWrites, collectConnects } from "../truth/collect.mjs";
import { parseMonitorLog, parseFindings } from "../score/monitor.mjs";
import { matchWrites, matchEgress } from "../score/match.mjs";
import { ruleCell } from "../score/rulematrix.mjs";
import { makeRow } from "../score/rows.mjs";
import { inWorkspace } from "../common/paths.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LOCK = JSON.parse(readFileSync(path.join(ROOT, "models.lock"), "utf8"));

// contracts/run.md, Run user. Checked before anything is created on disk.
export function assertNotRoot(geteuid = process.geteuid) {
  const euid = typeof geteuid === "function" ? geteuid() : null;
  if (euid === 0) throw new Error("runner: refusing to run as uid 0 (contracts/run.md, Run user)");
}

// contracts/run.md, Run id.
export function makeRunId(harness, scenarioId, repeat) {
  if (!Object.hasOwn(LOCK.harnesses, harness)) throw new Error(`unknown harness ${harness}`);
  if (!/^[a-z0-9-]+$/.test(scenarioId ?? "")) throw new Error(`runner: bad scenario id ${scenarioId}`);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error("runner: repeat must be 1 to 5");
  return `${harness}-${scenarioId}-${repeat}-${randomBytes(4).toString("hex")}`;
}

// R/ws, R/home and R/out, realpath'd, and the scenario's setup. Setup paths
// must stay under R (a scenario file cannot make the runner write elsewhere).
export function prepareRun({ harness, scenario, repeat = 1, tmp = process.env.HB_TMP || os.tmpdir(), geteuid } = {}) {
  assertNotRoot(geteuid);
  const runId = makeRunId(harness, scenario?.id, repeat);
  const root = realpathSync(mkdtempSync(path.join(realpathSync(tmp), `hb-${runId}-`)));
  const vars = { WS: path.join(root, "ws"), HOME: path.join(root, "home"), OUT: path.join(root, "out") };
  for (const d of Object.values(vars)) mkdirSync(d, { recursive: true });
  for (const s of substitute(scenario.setup ?? [], vars)) {
    const target = path.resolve(s.mkdir ?? s.file ?? "");
    if (!inWorkspace(target, root) || target === root) throw new Error(`runner: setup path ${target} is outside the run root`);
    if (s.mkdir) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, s.content ?? "", { mode: 0o644 });
    }
  }
  return { runId, root, vars };
}

// Startup exclusions measured in P5 (contracts/run.md, Startup exclusions):
// results/startup-<harness>-<version>.jsonl, one `path` per row, with
// ${HOME}, ${WS} and ${OUT} replaced for this run. None yet in P4.
export function startupPaths(harness, version, vars, dir = path.join(ROOT, "results")) {
  const f = path.join(dir, `startup-${harness}-${version}.jsonl`);
  if (!existsSync(f)) return [];
  const out = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.table === "startup" && typeof row.path === "string") out.push(substitute(row.path, vars));
  }
  return [...new Set(out)];
}

// The harness runs in its own process group (HB-P4-r1-C1). On timeout the
// whole group gets SIGKILL, not only the direct child, and when the harness
// exits whatever it left in the group gets SIGKILL too. A process that left
// the group and still holds stdout or stderr cannot hold the run open: the
// pipes are closed `pipeGraceMs` after the harness exits.
function spawnHarness(argv, { env, cwd, timeoutMs, pipeGraceMs = 2000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      resolve({ pid: null, status: null, signal: null, stdout: "", stderr: String(err.message), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let grace = null;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-65536)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-65536)));
    const t = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.on("error", (err) => (stderr += `\nspawn: ${err.message}`));
    child.on("exit", () => {
      clearTimeout(t);
      killGroup();
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, pipeGraceMs);
    });
    child.on("close", (status, signal) => {
      clearTimeout(t);
      clearTimeout(grace);
      resolve({ pid: child.pid ?? null, status, signal, stdout, stderr, timedOut });
    });
  });
}

const auditClock = () => Date.now() / 1000;

// One run of one harness on one scenario. Returns the run record (R/run.json)
// and what the scripted server saw. `monitor`, when given (P5), is
// { install({ home, workspace }) -> { exePrefixes, runEnv }, logPath({ home }) }.
// `auditLog`, when given (P5 on the box), is the host audit log to read after
// the harness exits; its slice for the window goes to R/audit.log
// (contracts/run.md, Audit log).
export async function runOnce({ harness, scenario, bin, repeat = 1, tmp, timeoutMs = 180000, monitor = null, geteuid, startupDir, auditLog = null, auditSettleMs = 1000 } = {}) {
  assertNotRoot(geteuid);
  const lock = LOCK.harnesses[harness];
  if (!Object.hasOwn(LOCK.harnesses, harness)) throw new Error(`unknown harness ${harness}`);
  if (typeof bin !== "string" || !path.isAbsolute(bin)) throw new Error("runner: bin must be an absolute path");
  const { runId, root, vars } = prepareRun({ harness, scenario, repeat, tmp, geteuid });
  const mon = monitor ? await monitor.install({ home: vars.HOME, workspace: vars.WS }) : { exePrefixes: [], runEnv: {} };
  const server = await startServer({ scenario, harness, vars });
  let result;
  let start;
  let end;
  try {
    const cmd = adapterFor(harness).command({ bin, workspace: vars.WS, home: vars.HOME, modelUrl: server.url, prompt: scenario.prompt, runEnv: mon.runEnv ?? {} });
    for (const [f, text] of Object.entries(cmd.files)) {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    start = auditClock();
    result = await spawnHarness(cmd.argv, { env: cmd.env, cwd: cmd.cwd, timeoutMs });
    end = auditClock();
  } finally {
    await server.close();
  }
  const run = {
    run_id: runId,
    harness,
    cli_version: lock.version,
    scenario: scenario.id,
    split: scenario.split,
    root_pid: result.pid,
    start,
    end,
    workspace: vars.WS,
    home: vars.HOME,
    exclude: {
      monitor_exe_prefixes: (mon.exePrefixes ?? []).map(String),
      // The scripted server runs in this process (contracts/api.md, startServer).
      model_server_pids: [process.pid],
      startup_paths: startupPaths(harness, lock.version, vars, startupDir),
    },
  };
  writeFileSync(path.join(root, "run.json"), JSON.stringify(run, null, 2) + "\n");
  let auditPath = null;
  if (auditLog) {
    // auditd writes asynchronously; give it a moment before reading the window.
    await new Promise((r) => setTimeout(r, auditSettleMs));
    auditPath = path.join(root, "audit.log");
    writeFileSync(auditPath, sliceAuditLog(readAuditLog(auditLog), start, end) + "\n", { mode: 0o600 });
  }
  return {
    auditPath,
    run,
    root,
    vars,
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    stderr: result.stderr,
    transcript: server.transcript,
    requests: server.requests.map(({ at, method, url, kind }) => ({ at, method, url, kind })),
    monitorLog: monitor ? monitor.logPath({ home: vars.HOME }) : null,
  };
}

// contracts/run.md, Audit log: the lines of an auditd log whose
// `msg=audit(<t>:` stamp is inside [start - 1, end + 1]. The collector applies
// the exact window; the margin only keeps the copy small.
export function sliceAuditLog(text, start, end) {
  const lo = start - 1;
  const hi = end + 1;
  return String(text ?? "")
    .split("\n")
    .filter((l) => {
      const m = /msg=audit\((\d+(?:\.\d+)?):/.exec(l);
      if (!m) return false;
      const t = Number(m[1]);
      return t >= lo && t <= hi;
    })
    .join("\n");
}

// Read the host's audit log as the run account. contracts/run.md, Audit log:
// the run account reads it through auditd's `log_group`; the runner never
// runs as root and never calls sudo.
export function readAuditLog(file = process.env.HB_AUDIT_LOG || "/var/log/audit/audit.log") {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`runner: cannot read the audit log ${file} (${err.code ?? err.message}); set auditd log_group to a group of the run account (contracts/run.md, Audit log)`);
  }
}

// Score one finished run into results rows (contracts/results.md): headline
// rows for both matchers, an egress row, and one rule_matrix row per rule the
// scenario is about. `meta` holds the section 6 fields except run_id, plus
// monitor_version and boundary.
export function scoreRun({ run, scenario, auditText, monitorText = "", findingsText = "", meta, vars }) {
  const truth = collectWrites(auditText, run);
  const connects = collectConnects(auditText, run);
  const rawEvents = [];
  for (const l of String(monitorText).split(/\r?\n/)) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o === "object" && !Array.isArray(o)) rawEvents.push(o);
    } catch {}
  }
  const { events } = parseMonitorLog(monitorText, { home: run.home, workspace: run.workspace });
  const findings = parseFindings(findingsText);
  const common = {
    ...meta,
    run_id: run.run_id,
    harness: run.harness,
    cli_version: run.cli_version,
    monitor_version: meta.monitor_version ?? null,
    split: run.split,
    scenario_count: 1,
  };
  delete common.boundary;
  const rows = [];
  for (const matcher of ["contract", "naive"]) {
    const m = matchWrites(truth, events, { matcher, rawEvents });
    rows.push(makeRow("headline", { ...common, scenario: run.scenario, matcher, numerator: m.numerator, denominator: m.denominator, rate: m.rate, excluded: m.excluded, other: m.other, in_workspace: m.in_workspace, missed: m.missed }));
  }
  const e = matchEgress(connects, rawEvents);
  rows.push(makeRow("egress", { ...common, connects: e.connects, named: e.named, missed: e.missed, loopback: e.loopback, failed: e.failed, excluded: e.excluded, hostnames: e.hostnames, boundary: meta.boundary ?? null }));
  for (const ruleId of scenario.about_rules ?? []) {
    rows.push(makeRow("rule_matrix", { ...common, rule_id: ruleId, scenario: run.scenario, cell: ruleCell({ ruleId, scenario, vars, truthRecords: truth, findings }) }));
  }
  return { rows, truth, connects };
}

export function removeRun(root) {
  if (typeof root === "string" && path.basename(root).startsWith("hb-")) rmSync(root, { recursive: true, force: true });
}
