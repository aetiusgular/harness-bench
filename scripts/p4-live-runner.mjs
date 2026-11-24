#!/usr/bin/env node
// P4 live check: the runner (src/run/runner.mjs) drives each pinned CLI
// through the scripted server on dev plain-shell, dotfile-edit and
// dotfile-program and the noop calibration, and appends one `smoke` row per
// harness and scenario to results/p4-live-runner.jsonl. No monitor and no
// auditd: it checks that each run exits 0, reached the server and left the
// scenario's expected files. Not run by ci (the CLIs are not installed there).
//
//   node scripts/p4-live-runner.mjs <prefix with the pinned CLIs in node_modules/.bin>
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runOnce, removeRun } from "../src/run/runner.mjs";
import { substitute } from "../src/model/vars.mjs";
import { makeRow } from "../src/score/rows.mjs";
import { section6 } from "../src/run/meta.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = JSON.parse(readFileSync(path.join(ROOT, "models.lock"), "utf8"));
const prefix = process.argv[2];
if (!prefix) {
  console.error("usage: node scripts/p4-live-runner.mjs <prefix>");
  process.exit(2);
}
const load = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
const SCENARIOS = ["fixtures/scenarios/dev/plain-shell.json", "fixtures/scenarios/dev/dotfile-edit.json", "fixtures/scenarios/dev/dotfile-program.json", "fixtures/calibration/noop.json"];
const out = path.join(ROOT, "results/p4-live-runner.jsonl");
let bad = 0;
for (const [h, lock] of Object.entries(LOCK.harnesses)) {
  const bin = path.join(path.resolve(prefix), "node_modules/.bin", lock.bin);
  const reported = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim().split("\n")[0];
  for (const rel of SCENARIOS) {
    const sc = load(rel);
    const r = await runOnce({ harness: h, scenario: sc, bin });
    const unsupported = r.transcript.some((t) => t.status === "unsupported");
    const expected = substitute(sc.expect, r.vars).map((e) => existsSync(e.path));
    const modelRequests = r.requests.filter((q) => q.kind !== "other").length;
    const keyless = r.status === 0 && modelRequests >= 1 && (unsupported ? expected.every((x) => !x) : expected.every(Boolean));
    if (!keyless) bad++;
    const row = makeRow("smoke", {
      ...section6({ runId: r.run.run_id }),
      harness: h,
      cli_version: lock.version,
      cli_version_reported: reported,
      monitor_version: null,
      split: sc.split,
      scenario_count: 1,
      scenario: sc.id,
      keyless_write: keyless,
      unsupported_step: unsupported,
      exit_status: r.status,
      requests: modelRequests,
      other_requests: r.requests.length - modelRequests,
    });
    appendFileSync(out, JSON.stringify(row) + "\n");
    console.log(`${h} ${sc.id}: exit ${r.status}, ${modelRequests} model requests, transcript ${r.transcript.map((t) => t.status).join(",") || "-"}, ok ${keyless}`);
    if (!keyless) console.log(r.stderr.slice(-800));
    removeRun(r.root);
  }
}
process.exit(bad ? 1 : 0);
