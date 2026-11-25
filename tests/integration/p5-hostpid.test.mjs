// P5 r3 tests for the runner's host pid resolution (HB-P5-r2-E1). The srt
// column runs the eval under bwrap --unshare-pid, so the runner sees namespace
// pids while auditd logs host pids. These records are modelled on a real
// record from this host: a node process inside bwrap --unshare-pid saw
// child.pid=9 and process.pid=2, while auditd logged the same execve as
// pid=1328280 ppid=1328266 with its cwd and argv intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostPids } from "../../src/run/runner.mjs";
import { collectWrites } from "../../src/truth/collect.mjs";

const WS = "/tmp/hb-claude-code-dotfile-edit-1-0a1b2c3d/ws";
const BIN = "/opt/p5/cli/node_modules/.bin/claude";
const HOST_ROOT = 1328280;
const HOST_RUNNER = 1328266;

function execve(serial, { pid, ppid, argv, cwd = WS, ts = "1764000000.200" }) {
  const args = argv.map((a, i) => `a${i}="${a}"`).join(" ");
  return [
    `type=SYSCALL msg=audit(${ts}:${serial}): arch=c000003e syscall=59 success=yes exit=0 a0=7ffd a1=1bdd a2=1bd6 a3=8 items=2 ppid=${ppid} pid=${pid} auid=4294967295 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=(none) ses=4294967295 comm="node" exe="/usr/bin/node" subj=unconfined key="hb_exec"`,
    `type=EXECVE msg=audit(${ts}:${serial}): argc=${argv.length} ${args}`,
    `type=CWD msg=audit(${ts}:${serial}): cwd="${cwd}"`,
    `type=EOE msg=audit(${ts}:${serial}):`,
  ];
}

function write(serial, { pid, ppid, name, ts = "1764000001.000" }) {
  return [
    `type=SYSCALL msg=audit(${ts}:${serial}): arch=c000003e syscall=257 success=yes exit=3 a0=ffffff9c a1=7ffd0000 a2=241 a3=1b6 items=1 ppid=${ppid} pid=${pid} auid=4294967295 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=(none) ses=4294967295 comm="node" exe="/usr/bin/node" subj=unconfined key="hb_write"`,
    `type=CWD msg=audit(${ts}:${serial}): cwd="${WS}"`,
    `type=PATH msg=audit(${ts}:${serial}): item=0 name="${name}" inode=4000 dev=08:02 mode=0100644 ouid=1000 ogid=1000 rdev=00:00 nametype=CREATE cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0`,
    `type=EOE msg=audit(${ts}:${serial}):`,
  ];
}

// A shebang CLI: the kernel's argv is the interpreter's, with the script path after it.
const LOG = [
  ...execve(10, { pid: HOST_ROOT, ppid: HOST_RUNNER, argv: ["/usr/bin/env", "node", BIN, "-p", "go"] }),
  ...write(11, { pid: HOST_ROOT, ppid: HOST_RUNNER, name: "/tmp/hb-claude-code-dotfile-edit-1-0a1b2c3d/home/.bashrc" }),
].join("\n");
const window = { start: 1764000000, end: 1764000100 };

function ctx(rootPid, serverPid) {
  return { run_id: "r", root_pid: rootPid, ...window, workspace: WS, home: "/tmp/hb-claude-code-dotfile-edit-1-0a1b2c3d/home", exclude: { monitor_exe_prefixes: [], model_server_pids: [serverPid], startup_paths: [] } };
}

test("namespace pids anchor no tree: the harness's out-of-workspace write is lost (HB-P5-r2-E1, the bug)", () => {
  assert.equal(collectWrites(LOG, ctx(9, 2)).length, 0);
});

test("hostPids takes the host root and runner pids from the harness's execve record (HB-P5-r2-E1)", () => {
  const h = hostPids(LOG, { argv0: BIN, cwd: WS, ...window, childPid: 9, selfPid: 2 });
  assert.deepEqual(h, { rootPid: HOST_ROOT, serverPid: HOST_RUNNER, from: "audit_translated" });
  const writes = collectWrites(LOG, ctx(h.rootPid, h.serverPid));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].pid, HOST_ROOT);
});

test("hostPids keeps the runner's pids when they are the host's, and marks a run with no execve record unanchored", () => {
  assert.deepEqual(hostPids(LOG, { argv0: BIN, cwd: WS, ...window, childPid: HOST_ROOT, selfPid: HOST_RUNNER }), { rootPid: HOST_ROOT, serverPid: HOST_RUNNER, from: "audit" });
  // Another cwd, another argv[0], or outside the window: not the harness.
  for (const log of [
    execve(20, { pid: 5, ppid: 4, argv: [BIN], cwd: "/tmp/other/ws" }).join("\n"),
    execve(21, { pid: 5, ppid: 4, argv: ["/usr/bin/true"] }).join("\n"),
    execve(22, { pid: 5, ppid: 4, argv: [BIN], ts: "1763998998.000" }).join("\n"),
  ]) {
    assert.deepEqual(hostPids(log, { argv0: BIN, cwd: WS, ...window, childPid: 9, selfPid: 2 }), { rootPid: 9, serverPid: 2, from: "unanchored" });
  }
});

test("hostPids finds a root execve stamped a few ms before start (the kernel's coarse audit clock)", () => {
  const log = execve(40, { pid: HOST_ROOT, ppid: HOST_RUNNER, argv: [BIN], ts: "1763999999.998" }).join("\n");
  assert.equal(hostPids(log, { argv0: BIN, cwd: WS, ...window, childPid: 9, selfPid: 2 }).from, "audit_translated");
});

test("hostPids takes the first execve in time order: the harness's own later execs do not move the root", () => {
  const log = [
    ...execve(31, { pid: HOST_ROOT + 1, ppid: HOST_ROOT, argv: [BIN, "child"], ts: "1764000002.000" }),
    ...execve(30, { pid: HOST_ROOT, ppid: HOST_RUNNER, argv: [BIN, "-p", "go"], ts: "1764000000.500" }),
  ].join("\n");
  assert.equal(hostPids(log, { argv0: BIN, cwd: WS, ...window, childPid: 9, selfPid: 2 }).rootPid, HOST_ROOT);
});
