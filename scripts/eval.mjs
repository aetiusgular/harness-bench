#!/usr/bin/env node
// P5 eval driver (contracts/eval.md). scripts/eval.sh calls it on the box.
//
//   node scripts/eval.mjs --prefix <dir> [--stage calibration,E0,E1-dev] [--harness a,b]
//        [--repeats 5] [--out results/<file>.jsonl] [--startup-dir results] [--pilot]
//        [--boundary <label>] [--summary results/summary.md] [--keep]
//
// <dir> holds the pinned tools, laid out by scripts/p5-setup.sh:
//   <dir>/cli/node_modules/.bin/<bin>   the four CLIs at models.lock versions
//   <dir>/beacon/bin/beacon             the monitor release in models.lock
//   <dir>/beacon/rules/rules/           its rule pack (sha256 in models.lock)
//
// Stages: `calibration` (noop x5 per harness -> results/startup-<h>-<v>.jsonl;
// an existing non-empty list there is reused, not recalibrated),
// `E0` (dev, one repeat), `E1-dev` (dev, --repeats per harness), `E1-heldout`
// (heldout, once per release; never in the default list). Every run row gets
// `stage`, `repeat`, `write_path`, `boundary`, `audit_rules`, `exit_status`,
// `worktree_clean`, `timed_out`, `audit_rotated`, `root_pid_from`, `unsupported_step` and `requests` beside the
// results.md fields. Band and write-path rows follow each E stage.
//
// Preflight, before any run: not root; the audit log is readable; the
// contract rules are loaded (a probe write and exec must show keys hb_write,
// hb_exec and hb_proc); CLI, monitor and rule-pack versions match
// models.lock. Without the contract rules it stops with exit 3, unless
// --pilot, which records `audit_rules: "host:<keys>"` on every row and writes
// startup lists under results/pilot/ so no pilot list is read by a real run.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce, scoreRun, removeRun, readAuditLog, sliceAuditLog, assertNotRoot } from "../src/run/runner.mjs";
import { beaconMonitor } from "../src/monitor/beacon.mjs";
import { section6 } from "../src/run/meta.mjs";
import { makeRow } from "../src/score/rows.mjs";
import { startupExclusions } from "../src/eval/startup.mjs";
import { aggregate } from "../src/eval/aggregate.mjs";
import { summarize } from "../src/eval/summary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = JSON.parse(readFileSync(path.join(ROOT, "models.lock"), "utf8"));

function args(argv) {
  const o = { stage: "calibration,E0,E1-dev", repeats: 5, boundary: process.env.HB_BOUNDARY || "none", pilot: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--prefix") o.prefix = v();
    else if (a === "--stage") o.stage = v();
    else if (a === "--harness") o.harness = v();
    else if (a === "--repeats") o.repeats = Number(v());
    else if (a === "--out") o.out = v();
    else if (a === "--startup-dir") o.startupDir = v();
    else if (a === "--summary") o.summary = v();
    else if (a === "--boundary") o.boundary = v();
    else if (a === "--pilot") o.pilot = true;
    else if (a === "--keep") o.keep = true;
    else throw new Error(`eval: unknown argument ${a}`);
  }
  if (!o.prefix) throw new Error("eval: --prefix is required");
  o.prefix = path.resolve(o.prefix);
  if (!Number.isInteger(o.repeats) || o.repeats < 1 || o.repeats > 5) throw new Error("eval: --repeats must be 1 to 5");
  o.stages = o.stage.split(",").filter(Boolean);
  for (const s of o.stages) if (!["calibration", "E0", "E1-dev", "E1-heldout"].includes(s)) throw new Error(`eval: unknown stage ${s}`);
  o.harnesses = o.harness ? o.harness.split(",") : Object.keys(LOCK.harnesses);
  for (const h of o.harnesses) if (!Object.hasOwn(LOCK.harnesses, h)) throw new Error(`eval: unknown harness ${h}`);
  const tag = o.pilot ? "p5-pilot" : "p5-eval";
  o.out = path.resolve(o.out ?? path.join(ROOT, "results", `${tag}.jsonl`));
  o.startupDir = path.resolve(o.startupDir ?? (o.pilot ? path.join(ROOT, "results", "pilot") : path.join(ROOT, "results")));
  o.summary = path.resolve(o.summary ?? path.join(ROOT, "results", o.pilot ? "p5-pilot-summary.md" : "summary.md"));
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HB-P5-r1-E1: git_sha names HEAD, so a run from an uncommitted tree names a
// commit that cannot reproduce it. Every row this driver writes also carries
// `worktree_clean`: false when a tracked file outside results/ differs from
// HEAD (null when git cannot tell).
function worktreeClean() {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude)results"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() === "";
  } catch {
    return null;
  }
}
const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

function loadSplit(split) {
  const dir = path.join(ROOT, "fixtures", "scenarios", split);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
}

// The contract rules are loaded when a probe write and exec by this account
// show up under their keys. auditctl -l needs root, so the log is the check.
async function probeRules(auditLog) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hb-probe-"));
  const target = path.join(dir, "probe");
  const t0 = Date.now() / 1000;
  spawnSync("/bin/sh", ["-c", ': > "$1"', "sh", target]);
  await sleep(1500);
  const t1 = Date.now() / 1000;
  const slice = sliceAuditLog(readAuditLog(auditLog, { since: t0 - 1 }), t0, t1);
  rmSync(dir, { recursive: true, force: true });
  const lines = slice.split("\n");
  const serials = new Set(lines.filter((l) => l.includes(`name="${target}"`)).map((l) => /msg=audit\([^:]+:(\d+)\)/.exec(l)?.[1]));
  const keysFor = (pred) => new Set(lines.filter(pred).map((l) => /key="([^"]*)"/.exec(l)?.[1]).filter(Boolean));
  const writeKeys = keysFor((l) => l.startsWith("type=SYSCALL") && serials.has(/msg=audit\([^:]+:(\d+)\)/.exec(l)?.[1]));
  const allKeys = keysFor(() => true);
  const contract = writeKeys.has("hb_write") && allKeys.has("hb_exec") && allKeys.has("hb_proc");
  return { contract, writeSeen: writeKeys.size > 0, keys: [...allKeys].sort() };
}

function cliVersion(bin) {
  return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 60000 }).trim().split("\n")[0];
}

async function preflight(o, auditLog) {
  assertNotRoot();
  readAuditLog(auditLog); // throws with the log_group hint
  const rules = await probeRules(auditLog);
  let auditRules;
  if (rules.contract) auditRules = "contract";
  else if (o.pilot && rules.writeSeen) auditRules = `host:${rules.keys.join(",")}`;
  else {
    const why = rules.writeSeen ? `the probe write was recorded under ${rules.keys.join(",")}, not hb_write/hb_exec/hb_proc` : "the probe write was not recorded at all";
    console.error(`eval: the contract audit rules are not loaded (${why}). Install contracts/audit.rules.template as its header says; that needs root and is Tony's step (SPEC.md, Risks).`);
    process.exit(3);
  }
  const bins = {};
  for (const h of o.harnesses) {
    const bin = path.join(o.prefix, "cli", "node_modules", ".bin", LOCK.harnesses[h].bin);
    const got = cliVersion(bin);
    if (!got.includes(LOCK.harnesses[h].version)) throw new Error(`eval: ${h} reports ${got}, models.lock pins ${LOCK.harnesses[h].version}`);
    bins[h] = { bin, reported: got };
  }
  const rulesTar = path.join(o.prefix, "beacon", "threat-rules.tar.gz");
  if (!existsSync(rulesTar) || sha256(rulesTar) !== LOCK.monitor.rules_sha256) throw new Error(`eval: ${rulesTar} does not match models.lock monitor.rules_sha256`);
  const monitor = beaconMonitor({ binDir: path.join(o.prefix, "beacon", "bin"), rulesDir: path.join(o.prefix, "beacon", "rules", "rules") });
  const mv = await monitor.version();
  if (mv !== LOCK.monitor.release) throw new Error(`eval: monitor reports ${mv}, models.lock pins ${LOCK.monitor.release}`);
  return { auditRules, bins, monitor, monitorVersion: mv };
}

async function oneRun(o, ctx, { harness, scenario, repeat, stage, startupDir }) {
  const r = await runOnce({ harness, scenario, bin: ctx.bins[harness].bin, repeat, monitor: ctx.monitor, auditLog: ctx.auditLog, startupDir, timeoutMs: 180000 });
  try {
    const monitorText = existsSync(r.monitorLog) ? readFileSync(r.monitorLog, "utf8") : "";
    const findingsText = monitorText ? await ctx.monitor.scan({ home: r.vars.HOME }) : "[]";
    const meta = { ...section6({ runId: r.run.run_id }), monitor_version: ctx.monitorVersion, boundary: o.boundary };
    const { rows, truth } = scoreRun({ run: r.run, scenario, vars: r.vars, auditText: readFileSync(r.auditPath, "utf8"), monitorText, findingsText, meta });
    const unsupported = r.transcript.some((t) => t.status === "unsupported");
    const extra = {
      stage,
      repeat,
      write_path: scenario.write_path,
      boundary: o.boundary,
      audit_rules: ctx.auditRules,
      worktree_clean: ctx.worktreeClean,
      cli_version_reported: ctx.bins[harness].reported,
      exit_status: r.status,
      timed_out: r.timedOut,
      audit_rotated: r.auditRotated,
      root_pid_from: r.rootPidFrom,
      unsupported_step: unsupported,
      requests: r.requests.filter((q) => q.kind !== "other").length,
    };
    return { rows: rows.map((row) => ({ ...row, ...extra })), truth, run: r.run, vars: r.vars, bad: r.timedOut || r.auditRotated || r.rootPidFrom === "unanchored" };
  } finally {
    if (!o.keep) removeRun(r.root);
  }
}

function append(file, rows) {
  mkdirSync(path.dirname(file), { recursive: true });
  for (const row of rows) appendFileSync(file, JSON.stringify(row) + "\n");
}

async function calibration(o, ctx) {
  const noop = JSON.parse(readFileSync(path.join(ROOT, "fixtures", "calibration", "noop.json"), "utf8"));
  const expect = ["dev", "heldout"].flatMap((s) => loadSplit(s)).flatMap((sc) => [...sc.expect, ...sc.expect_denied].map((e) => e.path));
  const empty = mkdtempSync(path.join(os.tmpdir(), "hb-nostartup-"));
  const report = [];
  for (const h of o.harnesses) {
    const lock = LOCK.harnesses[h];
    const file = path.join(o.startupDir, `startup-${h}-${lock.version}.jsonl`);
    // HB-P5-r1-E2: rows are never edited and only appended, so a second
    // calibration into the same file would union two lists and widen the
    // exclusions on every rerun. An existing list is reused as it stands, and
    // the summary says so; a new calibration needs a new --startup-dir.
    if (existsSync(file) && readFileSync(file, "utf8").trim() !== "") {
      const paths = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.table === "startup").map((r) => r.path);
      console.log(`calibration ${h}: reusing ${path.relative(ROOT, file)} (${paths.length} entries)`);
      report.push({ harness: h, paths, refused: [], reused: path.relative(ROOT, file) });
      continue;
    }
    const runs = [];
    for (let k = 1; k <= 5; k++) {
      const res = await oneRun(o, ctx, { harness: h, scenario: noop, repeat: k, stage: "calibration", startupDir: empty });
      const paths = res.truth.filter((t) => t.class === "headline" && t.excluded === null && !t.in_workspace).map((t) => t.path);
      runs.push({ vars: res.vars, paths, runId: res.run.run_id, bad: res.bad });
      console.log(`calibration ${h} ${k}: ${new Set(paths).size} out-of-workspace paths${res.bad ? " (timed out, rotated or unanchored)" : ""}`);
    }
    const { paths, refused } = startupExclusions(runs.filter((r) => !r.bad), { expect, tmpRoot: process.env.HB_TMP || os.tmpdir() });
    const rows = paths.map((p, i) =>
      makeRow("startup", {
        ...section6({ runId: `startup-${h}-${lock.version}-${i + 1}-${runs[0].runId.slice(-8)}` }),
        harness: h,
        cli_version: lock.version,
        monitor_version: ctx.monitorVersion,
        split: "calibration",
        scenario_count: 1,
        path: p,
        calibration_runs: runs.map((r) => r.runId),
        audit_rules: ctx.auditRules,
        worktree_clean: ctx.worktreeClean,
      }),
    );
    append(file, rows);
    report.push({ harness: h, paths, refused });
  }
  rmSync(empty, { recursive: true, force: true });
  return report;
}

async function stageRuns(o, ctx, stage) {
  const split = stage === "E1-heldout" ? "heldout" : "dev";
  const repeats = stage === "E0" ? 1 : o.repeats;
  const scenarios = loadSplit(split);
  const all = [];
  const dropped = [];
  for (const h of o.harnesses) {
    for (let k = 1; k <= repeats; k++) {
      for (const sc of scenarios) {
        const res = await oneRun(o, ctx, { harness: h, scenario: sc, repeat: k, stage, startupDir: o.startupDir });
        append(o.out, res.rows);
        all.push(...res.rows);
        if (res.bad) dropped.push(res.run.run_id);
        const c = res.rows.find((r) => r.table === "headline" && r.matcher === "contract");
        console.log(`${stage} ${h} ${sc.id} ${k}: contract ${c.numerator}/${c.denominator}${res.bad ? " (dropped)" : ""}`);
      }
    }
  }
  const meta = { ...section6({ runId: null }), stage, boundary: o.boundary, audit_rules: ctx.auditRules, worktree_clean: ctx.worktreeClean };
  delete meta.run_id;
  const { bands, writePaths } = aggregate(all, { meta, scenarioCount: scenarios.length, dropped });
  append(o.out, [...bands, ...writePaths]);
  return { stage, split, rows: all, bands, writePaths, dropped };
}

async function main() {
  const o = args(process.argv.slice(2));
  const auditLog = process.env.HB_AUDIT_LOG || "/var/log/audit/audit.log";
  const ctx = { auditLog, worktreeClean: worktreeClean(), ...(await preflight(o, auditLog)) };
  console.log(`eval: audit rules ${ctx.auditRules}, monitor ${ctx.monitorVersion}, boundary ${o.boundary}, out ${path.relative(ROOT, o.out)}`);
  const report = { calibration: null, stages: [], auditRules: ctx.auditRules, boundary: o.boundary, monitorVersion: ctx.monitorVersion, pilot: o.pilot, out: path.relative(ROOT, o.out) };
  for (const s of o.stages) {
    if (s === "calibration") report.calibration = await calibration(o, ctx);
    else report.stages.push(await stageRuns(o, ctx, s));
  }
  writeFileSync(o.summary, summarize(report));
  console.log(`eval: summary in ${path.relative(ROOT, o.summary)}`);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
