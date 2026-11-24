// Lane P3b red tests: the ground-truth collector (contracts/truth.md, contracts/api.md).
import assert from "node:assert/strict";
import { redTest, text, json } from "./lib.mjs";
import { renderRules } from "../../src/truth/rules.mjs";
import { parseAuditLog } from "../../src/truth/parse.mjs";
import { collectWrites } from "../../src/truth/collect.mjs";

const LOG = text("fixtures/audit/basic.log");
const CTX = json("fixtures/audit/basic.context.json");
const EXPECTED = json("fixtures/audit/basic.expected.json").records;
const FIELDS = ["run_id", "serial", "syscall", "op", "pid", "path", "in_workspace", "class", "excluded"];
const pick = (r) => Object.fromEntries(FIELDS.map((f) => [f, r[f]]));
const bySerial = (records, serial) => records.filter((r) => r.serial === serial).map(pick);
const want = (serial) => EXPECTED.filter((r) => r.serial === serial);

redTest("P3b-rules-render", "the rendered rules are the template with the uid filled in, nothing else changed", "truth.renderRules", async () => {
  assert.equal(renderRules({ uid: 1000 }), text("contracts/audit.rules.template").replaceAll("@UID@", "1000"));
});

redTest("P3b-rules-bad-uid", "a uid that is not a non-negative integer is refused", "truth.renderRules", async () => {
  for (const uid of [-1, 1.5, "1000; -D", undefined]) {
    assert.throws(() => renderRules({ uid }), /renderRules: uid must be a non-negative integer/);
  }
});

redTest("P3b-parse-group", "records are grouped into events by serial, in serial order, even when two events interleave", "truth.parseAuditLog", async () => {
  const events = parseAuditLog(LOG);
  assert.equal(events.length, 29);
  assert.deepEqual(events.map((e) => e.serial), [...events.map((e) => e.serial)].sort((a, b) => a - b));
  const e517 = events.find((e) => e.serial === 517);
  const e518 = events.find((e) => e.serial === 518);
  assert.equal(e517.syscall, "openat");
  assert.equal(e517.cwd, "/tmp/hb-r1/ws");
  assert.deepEqual(e517.paths.map((p) => [p.name, p.nametype]), [["../out/rel.txt", "CREATE"]]);
  assert.equal(e518.syscall, "execve");
  assert.deepEqual(e518.execve, ["true"]);
});

redTest("P3b-parse-hex", "a hex-encoded PATH name is decoded", "truth.parseAuditLog", async () => {
  const e = parseAuditLog(LOG).find((x) => x.serial === 511);
  assert.equal(e.paths[1].name, "/tmp/hb-r1/out/my notes.txt");
});

redTest("P3b-parse-enriched", "the ENRICHED log format parses to the same fields as RAW", "truth.parseAuditLog", async () => {
  const [e] = parseAuditLog(text("fixtures/audit/enriched.log"));
  assert.equal(e.serial, 601);
  assert.equal(e.syscall, "openat");
  assert.equal(e.exe, "/usr/bin/bash");
  assert.equal(e.key, "hb_write");
  assert.deepEqual(e.paths.map((p) => p.name), ["/tmp/hb-r1/out/", "/tmp/hb-r1/out/enriched.txt"]);
});

redTest("P3b-collect-basic", "the whole basic fixture gives exactly basic.expected.json", "truth.collectWrites", async () => {
  assert.deepEqual(collectWrites(LOG, CTX).map(pick), EXPECTED);
});

redTest("P3b-collect-enriched", "the enriched fixture gives enriched.expected.json", "truth.collectWrites", async () => {
  assert.deepEqual(collectWrites(text("fixtures/audit/enriched.log"), CTX).map(pick), json("fixtures/audit/enriched.expected.json").records);
});

redTest("P3b-collect-relative", "a relative name is joined to the event's cwd and .. removed", "truth.collectWrites", async () => {
  assert.deepEqual(bySerial(collectWrites(LOG, CTX), 517), want(517));
});

redTest("P3b-collect-workspace-prefix", "a sibling folder whose name starts with the workspace's is outside it", "truth.collectWrites", async () => {
  const out = collectWrites(LOG, CTX);
  assert.equal(bySerial(out, 513)[0]?.in_workspace, false);
  assert.equal(bySerial(out, 504)[0]?.in_workspace, true);
});

redTest("P3b-collect-readonly", "an openat without a write flag is not a write", "truth.collectWrites", async () => {
  assert.deepEqual(bySerial(collectWrites(LOG, CTX), 512), []);
});

redTest("P3b-collect-outside-tree", "a write by a process outside the harness's tree is not returned", "truth.collectWrites", async () => {
  assert.deepEqual(bySerial(collectWrites(LOG, CTX), 505), []);
});

redTest("P3b-collect-daemon", "a process reparented to pid 1 stays in the tree through its clone record", "truth.collectWrites", async () => {
  assert.deepEqual(bySerial(collectWrites(LOG, CTX), 521), want(521));
});

redTest("P3b-collect-window", "an event before the run's start (pid reuse) is dropped", "truth.collectWrites", async () => {
  assert.deepEqual(bySerial(collectWrites(LOG, CTX), 400), []);
});

redTest("P3b-collect-rename-target", "a rename is reported once, at its new name", "truth.collectWrites", async () => {
  assert.deepEqual(bySerial(collectWrites(LOG, CTX), 509), want(509));
});

redTest("P3b-collect-classes", "open, openat2 without CREATE, a failed write and an unresolvable dirfd name each get their own class", "truth.collectWrites", async () => {
  const out = collectWrites(LOG, CTX);
  for (const s of [514, 515, 516, 523, 528]) assert.deepEqual(bySerial(out, s), want(s), `serial ${s}`);
});

redTest("P3b-collect-exclusions", "monitor, model server and startup writes are returned, marked excluded", "truth.collectWrites", async () => {
  const out = collectWrites(LOG, CTX);
  for (const s of [508, 525, 526]) assert.deepEqual(bySerial(out, s), want(s), `serial ${s}`);
});
