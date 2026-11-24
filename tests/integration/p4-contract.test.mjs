// Tests for the contract changes P4 applied (DECISIONS.md, P4). Each names the
// Request for integration or review finding it closes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectWrites, collectConnects } from "../../src/truth/collect.mjs";
import { commandPaths, parseMonitorLog } from "../../src/score/monitor.mjs";
import { matchEgress } from "../../src/score/match.mjs";
import { auditEvent, CTX } from "./lib.mjs";

const SYS = { open: 2, rename: 82, renameat: 264, renameat2: 316, linkat: 265, symlinkat: 266, clone: 56, connect: 42 };

test("open, renameat, linkat and symlinkat are headline writes (Request for integration, P2 PR)", () => {
  // `mv a b` onto an existing b: coreutils tries renameat2(RENAME_NOREPLACE), gets EEXIST, then calls renameat.
  const log = [
    auditEvent(1, { syscall: SYS.open, a1: "241", paths: [["/r/out/legacy.txt", "CREATE"]] }),
    auditEvent(2, { syscall: SYS.renameat2, success: "no", exit: "-17", a2: "ffffff9c", paths: [["/r/out/", "PARENT"], ["/r/out/a.tmp", "DELETE"], ["/r/out/a.txt", "CREATE"]] }),
    auditEvent(3, { syscall: SYS.renameat, a2: "ffffff9c", paths: [["/r/out/", "PARENT"], ["/r/out/a.tmp", "DELETE"], ["/r/out/a.txt", "CREATE"]] }),
    auditEvent(4, { syscall: SYS.linkat, a2: "ffffff9c", paths: [["/r/out/", "PARENT"], ["/r/out/hard", "CREATE"]] }),
    auditEvent(5, { syscall: SYS.symlinkat, a1: "ffffff9c", paths: [["/r/out/", "PARENT"], ["/r/out/soft", "CREATE"]] }),
  ].join("\n");
  assert.deepEqual(collectWrites(log, CTX).map((r) => [r.serial, r.syscall, r.path, r.class]), [
    [1, "open", "/r/out/legacy.txt", "headline"],
    [2, "renameat2", "/r/out/a.txt", "denied"],
    [3, "renameat", "/r/out/a.txt", "headline"],
    [4, "linkat", "/r/out/hard", "headline"],
    [5, "symlinkat", "/r/out/soft", "headline"],
  ]);
});

test("the process tree is walked in time order, so a serial repeated across a boot keeps the child (HB-P3b-r1-C1)", () => {
  const log = [
    auditEvent(9, { ts: 1764000001, syscall: SYS.clone, exit: "200", key: "hb_proc" }),
    auditEvent(5, { ts: 1764000002, syscall: SYS.rename, pid: 200, ppid: 1, paths: [["/r/out/x", "CREATE"]] }),
  ].join("\n");
  const out = collectWrites(log, CTX);
  assert.deepEqual(out.map((r) => [r.serial, r.pid, r.path]), [[5, 200, "/r/out/x"]]);
});

test("connects to 0.0.0.0, :: and ::ffff:0.0.0.0 are loopback (HB-P3b-r1-E1)", () => {
  const sa4 = "02001F90000000000000000000000000";
  const sa6 = "0A001F90000000000000000000000000000000000000000000000000";
  const sa6m = "0A001F9000000000" + "00000000000000000000FFFF00000000" + "00000000";
  const log = [sa4, sa6, sa6m].map((saddr, i) => auditEvent(10 + i, { syscall: SYS.connect, saddr, key: "hb_net" })).join("\n");
  assert.deepEqual(collectConnects(log, CTX).map((r) => [r.address, r.class]), [["0.0.0.0", "loopback"], ["::", "loopback"], ["::ffff:0.0.0.0", "loopback"]]);
});

const P = (c) => commandPaths(c, { home: "/h", base: "/w" });

test("here-doc delimiters, here-doc bodies and here-strings are not paths (HB-P3c-r1-C1)", () => {
  assert.deepEqual(P("cat <<EOF > /tmp/x"), ["/tmp/x"]);
  assert.deepEqual(P("cat <<<hello; cat <<-EOF"), []);
  assert.deepEqual(P("cat > /o/f <<'EOF'\n/etc/not-written\nEOF\necho y >> /o/g"), ["/o/f", "/o/g"]);
  assert.deepEqual(P("cat <<-END > /o/f\n\t/body/x\n\tEND\n"), ["/o/f"]);
});

test("a nested sh -c or bash -lc command is split again (HB-P3c-r1-E1)", () => {
  assert.deepEqual(P("sh -c 'echo x > /tmp/z'"), ["/tmp/z"]);
  assert.deepEqual(P(`/bin/bash -lc "printf a >> ~/.bashrc && sh -c 'touch ../out/n'"`), ["/bin/bash", "/h/.bashrc", "/out/n"]); // a word with a / is a path (monitor.md)
  assert.deepEqual(P("echo sh -c /not/a/script-run"), ["/not/a/script-run"]);
  assert.deepEqual(P("sh tools/task.sh"), ["/w/tools/task.sh"]);
});

test("a nested shell after long options or an -o argument is split again (HB-P4-r1-E1)", () => {
  assert.deepEqual(P(`bash --noprofile --norc -c "echo x > /tmp/a"`), ["/tmp/a"]);
  assert.deepEqual(P(`bash -o pipefail -c "echo x > /tmp/a"`), ["/tmp/a"]);
  assert.deepEqual(P(`bash --rcfile /etc/rc -lc "echo x > /tmp/a"`), ["/tmp/a"]); // --rcfile's argument is an option value, not a word of the command
  assert.deepEqual(P(`bash --norc /w/s.sh`), ["/w/s.sh"]); // --norc does not run a command string
});

test("a JSON tool.command's command or cmd value is a command line (HB-P3c-r1-E2)", () => {
  const ev = (command) => JSON.stringify({ timestamp: "2026-11-24T10:00:00Z", sequence: 1, event: { action: "tool.invoked" }, tool: { command } });
  const log = [ev('{"command":"printf x >> /tmp/hb/out/a.txt"}'), ev(JSON.stringify({ cmd: ["bash", "-lc", "echo y > /tmp/hb/out/b.txt"] }))].join("\n");
  assert.deepEqual(parseMonitorLog(log, { home: "/h", workspace: "/w" }).events.map((e) => e.paths), [["/tmp/hb/out/a.txt"], ["/tmp/hb/out/b.txt"]]);
});

const conn = (address, port, family = "inet") => ({ run_id: "r", serial: 1, pid: 1, family, address, port, class: "egress", excluded: null });

test("egress: a JSON tool.command's values, --opt=<url>, bare IP words and nested shells name addresses", () => {
  const m = matchEgress([conn("192.0.2.1", 80), conn("192.0.2.2", 443), conn("192.0.2.3", 22), conn("2001:db8::9", 443, "inet6"), conn("192.0.2.4", 80), conn("192.0.2.5", 80)], [
    { tool: { command: '{"url":"http://192.0.2.1/x","method":"GET"}' } }, // Request for integration, P3c PR
    { command: { command: "curl --url=https://192.0.2.2/ -o x" } }, // HB-P3c-r1-C2
    { command: { command: "nc 192.0.2.3 22; ping -c1 2001:DB8::9" } }, // HB-P2-r2-E1
    { command: { command: "bash -lc 'curl http://192.0.2.4/'" } }, // nested shell
    { tool: { command: '{"command":"wget http://192.0.2.5/"}' } },
  ]);
  assert.deepEqual(m.missed, []);
  assert.equal(m.named, 6);
  // A bare address that only starts with the connected one still does not name it.
  assert.deepEqual(matchEgress([conn("192.0.2.10", 443)], [{ command: { command: "echo 192.0.2.100" } }]).missed, ["192.0.2.10:443"]);
});
