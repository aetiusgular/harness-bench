// P4 cross-lane tests: lane P3b's collector output feeds lane P3c's matcher,
// scorer and rows, through the runner's scoreRun, on the committed fixtures.
// The P3c red tests read fixtures/audit/*.expected.json; these read what the
// collector actually returns from the .log files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectWrites, collectConnects, normalizePath as truthNormalize } from "../../src/truth/collect.mjs";
import { parseMonitorLog } from "../../src/score/monitor.mjs";
import { matchWrites, matchEgress } from "../../src/score/match.mjs";
import { normalizeAbsolute as scoreNormalize } from "../../src/score/words.mjs";
import { scoreRun } from "../../src/run/runner.mjs";
import { read, json } from "./lib.mjs";

const ctx = json("fixtures/audit/basic.context.json");
const raw = (text) => text.split("\n").filter((l) => l.trim()).flatMap((l) => { try { const o = JSON.parse(l); return o && typeof o === "object" && !Array.isArray(o) ? [o] : []; } catch { return []; } });

test("collector -> matcher: basic.log and the runtime log give the monitor fixture's numbers for both matchers", () => {
  const truth = collectWrites(read("fixtures/audit/basic.log"), ctx);
  const text = read("fixtures/monitor/basic.runtime.jsonl");
  const { events } = parseMonitorLog(text, { home: ctx.home, workspace: ctx.workspace });
  const want = json("fixtures/monitor/basic.expected.json");
  for (const matcher of ["contract", "naive"]) {
    const m = matchWrites(truth, events, { matcher, rawEvents: raw(text) });
    for (const k of ["numerator", "denominator", "rate", "matched"]) assert.deepEqual(m[k], want[matcher][k], `${matcher} ${k}`);
    assert.deepEqual(m.excluded, want.excluded);
    assert.deepEqual(m.other, want.other);
    assert.equal(m.in_workspace, want.in_workspace);
  }
});

test("collector -> egress join: connect.log and its runtime log give the connect fixture", () => {
  const want = json("fixtures/monitor/connect.expected.json");
  const m = matchEgress(collectConnects(read("fixtures/audit/connect.log"), ctx), raw(read("fixtures/monitor/connect.runtime.jsonl")));
  for (const k of ["connects", "named", "matched", "missed", "loopback", "failed", "excluded", "hostnames"]) assert.deepEqual(m[k], want[k], k);
});

test("scoreRun turns a run into headline, egress and rule_matrix rows that carry every results.md field", () => {
  const scenario = { id: "dotfile-edit", split: "dev", about_rules: ["shell-login-dotfile-modified"], expect: [{ op: "write", path: "${HOME}/.bashrc" }] };
  const run = { ...ctx, harness: "claude-code", cli_version: "2.1.331", scenario: "dotfile-edit", split: "dev" };
  const meta = { git_sha: "x", machine: "m", model_revision: "h", quant: null, runtime: "node", date: "2026-11-24T00:00:00Z", monitor_version: "v1.3.67", boundary: "none" };
  const vars = { WS: ctx.workspace, HOME: ctx.home, OUT: "/tmp/hb-r1/out" };
  const { rows } = scoreRun({ run, scenario, vars, meta, auditText: read("fixtures/audit/basic.log"), monitorText: read("fixtures/monitor/basic.runtime.jsonl"), findingsText: read("fixtures/monitor/basic.scan.json") });
  assert.deepEqual(rows.map((r) => [r.table, r.matcher ?? r.rule_id ?? null]), [["headline", "contract"], ["headline", "naive"], ["egress", null], ["rule_matrix", "shell-login-dotfile-modified"]]);
  for (const r of rows) {
    for (const f of ["run_id", "git_sha", "machine", "model_revision", "quant", "runtime", "date", "harness", "cli_version", "monitor_version", "split", "scenario_count"]) assert.ok(Object.hasOwn(r, f), `${r.table} lacks ${f}`);
    assert.equal(r.run_id, "r1");
    assert.ok(!("boundary" in r) || r.table === "egress");
  }
  assert.equal(rows[0].denominator, 11);
  assert.equal(rows[3].cell, "fired");
});

test("one path normalizer: the collector and the scorer normalize every case the same", () => {
  for (const p of ["/", "//", "/a/./b/../c", "/a//b/", "/../x", "/tmp/hb-r1/out/./link", "/a b/c d/", "/x/..", "/é/ü/"]) {
    assert.equal(truthNormalize(p), scoreNormalize(p), p);
  }
  assert.equal(truthNormalize, scoreNormalize);
});
