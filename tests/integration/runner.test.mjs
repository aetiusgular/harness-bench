// P4 cross-lane tests for the runner: the frozen dev scenarios (fixtures),
// lane P3a's scripted server and claude-code adapter, and the runner's
// layout, run.json and root guard, with a stand-in CLI (fake-cli.mjs) in place
// of a real harness. Real CLIs run in tests/model/live.test.mjs and on the box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNotRoot, makeRunId, prepareRun, runOnce, sliceAuditLog, readAuditLog, removeRun, startupPaths } from "../../src/run/runner.mjs";
import { substitute } from "../../src/model/vars.mjs";
import { FAKE_CLI, scenarios } from "./lib.mjs";

const tmpdir = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "hb-it-")));

test("the runner refuses euid 0 before it creates anything (HB-P2-r2-S1)", async () => {
  const tmp = tmpdir();
  try {
    const root = () => 0;
    assert.throws(() => assertNotRoot(root), /refusing to run as uid 0/);
    assert.throws(() => prepareRun({ harness: "claude-code", scenario: scenarios("dev")[0], tmp, geteuid: root }), /refusing to run as uid 0/);
    await assert.rejects(runOnce({ harness: "claude-code", scenario: scenarios("dev")[0], bin: FAKE_CLI, tmp, geteuid: root }), /refusing to run as uid 0/);
    assert.deepEqual(readdirSync(tmp), []);
    assert.doesNotThrow(() => assertNotRoot(() => 1000));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("run ids follow contracts/run.md and bad parts are refused", () => {
  assert.match(makeRunId("codex", "dotfile-edit", 3), /^codex-dotfile-edit-3-[0-9a-f]{8}$/);
  assert.throws(() => makeRunId("nope", "x", 1), /unknown harness nope/);
  assert.throws(() => makeRunId("codex", "../x", 1), /bad scenario id/);
  assert.throws(() => makeRunId("codex", "x", 6), /repeat must be 1 to 5/);
});

test("prepareRun lays out R/ws, R/home and R/out under a realpath'd root and refuses setup outside R", () => {
  const tmp = tmpdir();
  try {
    const sc = scenarios("dev").find((s) => s.id === "dotfile-program");
    const { root, vars, runId } = prepareRun({ harness: "codex", scenario: sc, tmp });
    assert.equal(path.dirname(root), tmp);
    assert.ok(path.basename(root).startsWith(`hb-${runId}-`));
    assert.deepEqual(vars, { WS: `${root}/ws`, HOME: `${root}/home`, OUT: `${root}/out` });
    for (const s of substitute(sc.setup, vars)) assert.ok(existsSync(s.file ?? s.mkdir));
    const evil = { ...sc, id: "evil", setup: [{ file: "${WS}/../../escape.txt", content: "x" }] };
    assert.throws(() => prepareRun({ harness: "codex", scenario: evil, tmp }), /outside the run root/);
    assert.ok(!existsSync(path.join(tmp, "escape.txt")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

for (const sc of scenarios("dev")) {
  test(`runOnce: dev ${sc.id} through the scripted server and the claude-code adapter`, async () => {
    const tmp = tmpdir();
    try {
      const r = await runOnce({ harness: "claude-code", scenario: sc, bin: FAKE_CLI, tmp, timeoutMs: 30000 });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.transcript.map((t) => t.status), sc.steps.map(() => "sent"));
      assert.ok(r.requests.every((q) => q.kind === "turn"), JSON.stringify(r.requests));
      // A rename scenario's first write is the rename's source, so it is gone by the end.
      const renames = sc.expect.some((e) => e.op === "rename");
      for (const e of substitute(sc.expect, r.vars)) if (e.op === "rename" || (e.op !== "unlink" && !renames)) assert.ok(existsSync(e.path), `${sc.id}: ${e.path} missing`);
      for (const e of substitute(sc.expect, r.vars)) if (e.op === "unlink") assert.ok(!existsSync(e.path), `${sc.id}: ${e.path} still there`);
      const run = JSON.parse(readFileSync(path.join(r.root, "run.json"), "utf8"));
      assert.deepEqual(run, r.run);
      assert.deepEqual(Object.keys(run), ["run_id", "harness", "cli_version", "scenario", "split", "root_pid", "start", "end", "workspace", "home", "exclude"]);
      assert.equal(run.cli_version, "2.1.331");
      assert.ok(Number.isInteger(run.root_pid) && run.root_pid !== process.pid);
      assert.ok(run.start <= run.end && run.end <= Date.now() / 1000);
      assert.deepEqual(run.exclude.model_server_pids, [process.pid]);
      assert.equal(run.workspace, r.vars.WS);
      removeRun(r.root);
      assert.ok(!existsSync(r.root));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test("runOnce with auditLog writes the window's slice to R/audit.log", async () => {
  const tmp = tmpdir();
  try {
    const fake = path.join(tmp, "host-audit.log");
    const now = Date.now() / 1000;
    writeFileSync(fake, [`type=SYSCALL msg=audit(${(now - 3600).toFixed(3)}:1): old`, `type=SYSCALL msg=audit(${(now + 0.5).toFixed(3)}:2): in`].join("\n") + "\n");
    const sc = scenarios("dev").find((s) => s.id === "plain-shell");
    const r = await runOnce({ harness: "claude-code", scenario: sc, bin: FAKE_CLI, tmp, auditLog: fake, auditSettleMs: 0 });
    assert.equal(r.auditPath, path.join(r.root, "audit.log"));
    assert.equal(readFileSync(r.auditPath, "utf8"), `type=SYSCALL msg=audit(${(now + 0.5).toFixed(3)}:2): in\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the hosts scenarios' /etc/hosts write is refused by the kernel for the run account", { skip: process.geteuid?.() === 0 && "running as root" }, async () => {
  const sc = scenarios("dev").find((s) => s.id === "hosts-edit");
  const tmp = tmpdir();
  try {
    const before = readFileSync("/etc/hosts", "utf8");
    const r = await runOnce({ harness: "claude-code", scenario: sc, bin: FAKE_CLI, tmp, timeoutMs: 30000 });
    assert.equal(r.status, 0);
    assert.equal(readFileSync("/etc/hosts", "utf8"), before);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("sliceAuditLog keeps the window plus one second, and readAuditLog names the fix when it cannot read", () => {
  const log = ["type=SYSCALL msg=audit(99.000:1): a", "type=SYSCALL msg=audit(100.500:2): b", "noise", "type=SYSCALL msg=audit(105.000:3): c", "type=SYSCALL msg=audit(107.000:4): d"].join("\n");
  assert.equal(sliceAuditLog(log, 100, 106), ["type=SYSCALL msg=audit(99.000:1): a", "type=SYSCALL msg=audit(100.500:2): b", "type=SYSCALL msg=audit(105.000:3): c", "type=SYSCALL msg=audit(107.000:4): d"].join("\n"));
  assert.equal(sliceAuditLog(log, 101, 104), "type=SYSCALL msg=audit(100.500:2): b\ntype=SYSCALL msg=audit(105.000:3): c");
  assert.throws(() => readAuditLog("/nonexistent/hb/audit.log"), /log_group/);
});

test("startupPaths reads startup rows and replaces the run's variables", () => {
  const tmp = tmpdir();
  try {
    const vars = { WS: "/r/ws", HOME: "/r/home", OUT: "/r/out" };
    assert.deepEqual(startupPaths("codex", "0.172.0", vars, tmp), []);
    const rows = [{ table: "startup", path: "${HOME}/.codex/" }, { table: "startup", path: "${HOME}/.codex/" }, { table: "smoke", path: "/x" }];
    writeFileSync(path.join(tmp, "startup-codex-0.172.0.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    assert.deepEqual(startupPaths("codex", "0.172.0", vars, tmp), ["/r/home/.codex/"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
