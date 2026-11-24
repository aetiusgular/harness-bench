// Lane P3b tests beyond the red set: corners of the auditd format and of
// contracts/truth.md that the P2 fixtures do not carry. Logs are built inline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAuditLog } from "../../src/truth/parse.mjs";
import { collectWrites, collectConnects, formatInet6, normalizePath } from "../../src/truth/collect.mjs";
import { renderRules } from "../../src/truth/rules.mjs";

const CTX = {
  run_id: "t1",
  root_pid: 100,
  start: 1000,
  end: 2000,
  workspace: "/r/ws",
  home: "/r/home",
  exclude: { monitor_exe_prefixes: ["/r/home/.mon/"], model_server_pids: [50], startup_paths: ["/r/home/.cfg/"] },
};

const hex = (s) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

// One event's records. `sys` holds SYSCALL fields; `paths` [name, nametype] pairs.
function ev(serial, { ts = 1500, syscall, success = "yes", exit = "3", a0 = "ffffff9c", a1 = "0", a2 = "0", pid = 101, ppid = 100, exe = '"/usr/bin/sh"', cwd = '"/r/ws"', paths = [] }) {
  const t = `${ts}.000:${serial}`;
  const lines = [
    `type=SYSCALL msg=audit(${t}): arch=c000003e syscall=${syscall} success=${success} exit=${exit} a0=${a0} a1=${a1} a2=${a2} a3=0 items=${paths.length} ppid=${ppid} pid=${pid} auid=1000 uid=1000 euid=1000 comm="sh" exe=${exe} key="hb_write"`,
    `type=CWD msg=audit(${t}): cwd=${cwd}`,
    ...paths.map(([name, nt], i) => `type=PATH msg=audit(${t}): item=${i} name=${name} inode=1 dev=08:02 mode=0100644 nametype=${nt}`),
    `type=EOE msg=audit(${t}):`,
  ];
  return lines.join("\n");
}

test("hex-encoded cwd and exe are decoded, (null) key is null, a node= prefix is read", () => {
  const log = [
    `node=box type=SYSCALL msg=audit(1500.000:1): arch=c000003e syscall=257 success=yes exit=3 a0=ffffff9c a1=0 a2=241 a3=0 items=1 ppid=100 pid=101 comm=${hex("my sh")} exe=${hex("/opt/my tools/sh")} key=(null)`,
    `node=box type=CWD msg=audit(1500.000:1): cwd=${hex("/r/ws/sub dir")}`,
    `node=box type=PATH msg=audit(1500.000:1): item=0 name="../a.txt" nametype=CREATE`,
  ].join("\n");
  const [e] = parseAuditLog(log);
  assert.equal(e.comm, "my sh");
  assert.equal(e.exe, "/opt/my tools/sh");
  assert.equal(e.key, null);
  assert.equal(e.cwd, "/r/ws/sub dir");
  const [w] = collectWrites(log, CTX);
  assert.equal(w.path, "/r/ws/a.txt");
  assert.equal(w.in_workspace, true);
});

test("EXECVE: quoted, hex and chunked long arguments", () => {
  const t = "1500.000:2";
  const log = [
    `type=SYSCALL msg=audit(${t}): arch=c000003e syscall=59 success=yes exit=0 a0=0 a1=0 a2=0 a3=0 items=0 ppid=100 pid=101 comm="sh" exe="/usr/bin/sh" key="hb_exec"`,
    `type=EXECVE msg=audit(${t}): argc=3 a0="sh" a1=${hex("-c x")} a2_len=8`,
    `type=EXECVE msg=audit(${t}): a2[0]=${hex("abcd")}`,
    `type=EXECVE msg=audit(${t}): a2[1]=${hex("efgh")}`,
  ].join("\n");
  assert.deepEqual(parseAuditLog(log)[0].execve, ["sh", "-c x", "abcdefgh"]);
});

test("the directory fd of renameat2's new name is a2, of symlinkat's a1", () => {
  // a0 (olddirfd) is a real fd, a2 (newdirfd) is AT_FDCWD: the new name resolves.
  const r1 = ev(3, { syscall: 316, a0: "5", a2: "ffffff9c", paths: [['"/r/out/"', "PARENT"], ['"old"', "DELETE"], ['"new.txt"', "CREATE"]] });
  // newdirfd is a real fd: the name cannot be resolved from the log.
  const r2 = ev(4, { syscall: 316, a0: "ffffff9c", a2: "7", paths: [['"old"', "DELETE"], ['"new2.txt"', "CREATE"]] });
  const s1 = ev(5, { syscall: 266, a0: "7fff0000", a1: "ffffff9c", paths: [['"ln"', "CREATE"]] });
  const out = collectWrites([r1, r2, s1].join("\n"), CTX);
  assert.deepEqual(out.map((r) => [r.serial, r.path, r.class]), [
    [3, "/r/ws/new.txt", "headline"],
    [4, "new2.txt", "unresolved"],
    [5, "/r/ws/ln", "other_syscall"],
  ]);
});

test("a sign-extended AT_FDCWD is AT_FDCWD", () => {
  const log = ev(6, { syscall: 257, a0: "ffffffffffffff9c", a2: "41", paths: [['"x"', "CREATE"]] });
  assert.equal(collectWrites(log, CTX)[0].path, "/r/ws/x");
});

test("a failed write is denied even when its name is unresolvable; a read-only open is never returned", () => {
  const denied = ev(7, { syscall: 257, success: "no", exit: "-13", a0: "4", a2: "1", paths: [['"y"', "UNKNOWN"]] });
  const ro = ev(8, { syscall: 257, success: "no", exit: "-2", a2: "80000", paths: [['"/r/out/z"', "UNKNOWN"]] });
  const out = collectWrites([denied, ro].join("\n"), CTX);
  assert.deepEqual(out.map((r) => [r.serial, r.path, r.class]), [[7, "y", "denied"]]);
});

test("the time window is inclusive and drops the event outside it before the tree is built", () => {
  // A clone before start must not bring its child into the tree.
  const early = ev(9, { ts: 999, syscall: 56, exit: "300", a2: "0" });
  const child = ev(10, { syscall: 257, pid: 300, ppid: 1, a2: "41", paths: [['"/r/out/c"', "CREATE"]] });
  const atStart = ev(11, { ts: 1000, syscall: 257, a2: "41", paths: [['"/r/out/s"', "CREATE"]] });
  const atEnd = ev(12, { ts: 2000, syscall: 257, a2: "41", paths: [['"/r/out/e"', "CREATE"]] });
  assert.deepEqual(collectWrites([early, child, atStart, atEnd].join("\n"), CTX).map((r) => r.serial), [11, 12]);
});

test("startup exclusion: a folder entry covers what is under it, a file entry only itself; the monitor wins first", () => {
  const a = ev(13, { syscall: 257, a2: "41", paths: [['"/r/home/.cfg/state.json"', "CREATE"]] });
  const b = ev(14, { syscall: 257, a2: "41", paths: [['"/r/home/.cfgx"', "CREATE"]] });
  const c = ev(15, { syscall: 257, a2: "41", exe: '"/r/home/.mon/bin/m"', paths: [['"/r/home/.cfg/m.log"', "CREATE"]] });
  const out = collectWrites([a, b, c].join("\n"), CTX);
  assert.deepEqual(out.map((r) => r.excluded), ["startup", null, "monitor"]);
});

test("path normalization removes . and .., collapses slashes and a trailing slash, and stops at /", () => {
  assert.equal(normalizePath("//r//ws/./a/../b/"), "/r/ws/b");
  assert.equal(normalizePath("/../../etc/hosts"), "/etc/hosts");
  assert.equal(normalizePath("/"), "/");
});

test("RFC 5952: longest zero run compressed, first on a tie, a lone zero group kept, mapped IPv4 dotted", () => {
  const b = (h) => Buffer.from(h, "hex");
  assert.equal(formatInet6(b("00000000000000000000000000000001")), "::1");
  assert.equal(formatInet6(b("00000000000000000000000000000000")), "::");
  assert.equal(formatInet6(b("20010db8000000010000000000000001")), "2001:db8:0:1::1");
  assert.equal(formatInet6(b("20010db8000000000001000000000001")), "2001:db8::1:0:0:1");
  assert.equal(formatInet6(b("20010db8000100010001000100010001")), "2001:db8:1:1:1:1:1:1");
  assert.equal(formatInet6(b("20010db8000000010001000100010001")), "2001:db8:0:1:1:1:1:1");
  assert.equal(formatInet6(b("00000000000000000000ffffc0000201")), "::ffff:192.0.2.1");
});

test("connect: an IPv4-mapped loopback is loopback, a short SOCKADDR is skipped", () => {
  const t1 = "1500.000:20";
  const t2 = "1500.000:21";
  const sys = (t) => `type=SYSCALL msg=audit(${t}): arch=c000003e syscall=42 success=yes exit=0 a0=3 a1=0 a2=1c a3=0 items=0 ppid=100 pid=101 comm="node" exe="/usr/bin/node" key="hb_net"`;
  const log = [
    sys(t1),
    `type=SOCKADDR msg=audit(${t1}): saddr=${"0A00" + "1F90" + "00000000" + "00000000000000000000FFFF7F000001" + "00000000"}`,
    sys(t2),
    `type=SOCKADDR msg=audit(${t2}): saddr=0200`,
  ].join("\n");
  const out = collectConnects(log, CTX);
  assert.deepEqual(out.map((r) => [r.serial, r.family, r.address, r.port, r.class]), [[20, "inet6", "::ffff:127.0.0.1", 8080, "loopback"]]);
});

test("renderRules refuses a non-number uid string and keeps every template line", () => {
  assert.throws(() => renderRules({ uid: "1000" }), /non-negative integer/);
  assert.throws(() => renderRules(), /non-negative integer/);
  const out = renderRules({ uid: 1234 });
  assert.ok(!out.includes("@UID@"));
  assert.equal(out.match(/euid=1234 /g).length, 7);
});
