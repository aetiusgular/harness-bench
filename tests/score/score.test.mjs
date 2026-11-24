// Lane P3c tests beyond the red set: corners of contracts/monitor.md and
// contracts/results.md that the P2 fixtures do not carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMonitorLog, commandPaths, parseFindings } from "../../src/score/monitor.mjs";
import { matchWrites, matchEgress, canonicalInet6 } from "../../src/score/match.mjs";
import { rate, band } from "../../src/score/band.mjs";
import { makeRow } from "../../src/score/rows.mjs";
import { ruleCell } from "../../src/score/rulematrix.mjs";
import { shellTokens, normalizePath } from "../../src/score/words.mjs";

const base = { home: "/r/home", base: "/r/ws" };
const line = (o) => JSON.stringify({ timestamp: "2026-11-24T10:00:00Z", sequence: 1, event: { action: "command.executed" }, ...o });

test("redirect operators: 2>, &>, 2>>, >| and >> name their target; 2>&1 and >&2 do not", () => {
  assert.deepEqual(commandPaths("make 2>err.log", base), ["/r/ws/err.log"]);
  assert.deepEqual(commandPaths("make &> all.log", base), ["/r/ws/all.log"]);
  assert.deepEqual(commandPaths("make 2>>e2 >|clob", base).sort(), ["/r/ws/clob", "/r/ws/e2"]);
  assert.deepEqual(commandPaths("echo hi>>x", base), ["/r/ws/x"]);
  assert.deepEqual(commandPaths("make >out 2>&1", base), ["/r/ws/out"]);
  assert.deepEqual(commandPaths("echo x >&2", base), []);
  assert.deepEqual(commandPaths("cat < in.txt", base), ["/r/ws/in.txt"]);
});

test("a 2 that is part of a word is not a file descriptor", () => {
  assert.deepEqual(commandPaths("echo a2>f", base), ["/r/ws/f"]);
  assert.deepEqual(shellTokens("echo a2>f").map((t) => t.value), ["echo", "a2", ">", "f"]);
});

test("pipes, ; and && split words, and both sides are read", () => {
  assert.deepEqual(commandPaths("cat /a/b | tee /c/d; true && cp x/y ~/z", base).sort(), ["/a/b", "/c/d", "/r/home/z", "/r/ws/x/y"]);
});

test("backslash escapes, double-quote escapes and an unterminated quote", () => {
  assert.deepEqual(commandPaths("touch /tmp/a\\ b", base), ["/tmp/a b"]);
  assert.deepEqual(commandPaths('touch "/tmp/q\\"t"', base), ['/tmp/q"t']);
  assert.deepEqual(commandPaths("touch '/tmp/open", base), ["/tmp/open"]);
});

test("~ alone is home, ~user is not expanded, and $VARS are not expanded", () => {
  assert.deepEqual(commandPaths("cd ~", base), ["/r/home"]);
  assert.deepEqual(commandPaths("ls ~bob/x", base), ["/r/ws/~bob/x"]);
  assert.deepEqual(commandPaths("echo x > $HOME/.bashrc", base), ["/r/ws/$HOME/.bashrc"]);
});

test("a word that starts with - is an option even when quoted, since the program sees the same argv", () => {
  assert.deepEqual(commandPaths("rm -- '-dir/x' -rf -/y", base), []);
  assert.deepEqual(commandPaths("gcc -o out/a.o '--sysroot=~/sr'", base).sort(), ["/r/home/sr", "/r/ws/out/a.o"]);
});

test("normalization: .. past the root stays at the root, repeated and trailing / go", () => {
  assert.equal(normalizePath("/../../etc//hosts/", base), "/etc/hosts");
  assert.equal(normalizePath("/", base), "/");
  assert.equal(normalizePath("a", {}), null);
  assert.equal(normalizePath("~/a", { base: "/r/ws" }), null);
});

test("parseMonitorLog: JSON that is not an object is a bad line; blank lines are not", () => {
  const { events, bad_lines } = parseMonitorLog(["[1]", "42", "null", "", "   ", line({})].join("\n"), { home: "/r/home", workspace: "/r/ws" });
  assert.equal(events.length, 1);
  assert.equal(bad_lines, 3);
});

test("parseMonitorLog: a missing working_directory falls back to the workspace", () => {
  const { events } = parseMonitorLog(line({ command: { command: "rm sub/x" } }), { home: "/r/home", workspace: "/r/ws" });
  assert.deepEqual(events[0].paths, ["/r/ws/sub/x"]);
  const { events: e2 } = parseMonitorLog(line({ session: { working_directory: "/elsewhere" }, command: { command: "rm sub/x" } }), { home: "/r/home", workspace: "/r/ws" });
  assert.deepEqual(e2[0].paths, ["/elsewhere/sub/x"]);
});

test("parseMonitorLog: tool.path, JSON tool.command keys and parsed_commands file_writes", () => {
  const o = {
    tool: { path: "a.txt", command: JSON.stringify({ old_path: "/o/1", new_path: "~/n", content: "/not/a/key", filePath: 7 }) },
    command: { parsed_commands: [{ file_writes: [{ path: "../w" }, {}] }, null] },
  };
  const { events } = parseMonitorLog(line(o), { home: "/r/home", workspace: "/r/ws" });
  assert.deepEqual(events[0].paths.sort(), ["/o/1", "/r/home/n", "/r/w", "/r/ws/a.txt"]);
});

test("parseMonitorLog: a JSON tool.command that is not an object is read as a command line", () => {
  const { events } = parseMonitorLog(line({ tool: { command: '"/tmp/s"' } }), { home: "/r/home", workspace: "/r/ws" });
  assert.deepEqual(events[0].paths, ["/tmp/s"]);
});

test("parseMonitorLog: order by time with mixed fraction digits and offsets, then sequence, then line", () => {
  const ev = (timestamp, sequence, tag) => JSON.stringify({ timestamp, sequence, event: { action: tag } });
  const text = [
    ev("2026-11-24T10:00:00.5Z", 1, "c"),
    ev("2026-11-24T10:00:00Z", 2, "a"),
    ev("2026-11-24T12:00:00.1+02:00", 1, "b"),
    ev("not a time", 1, "z"),
    ev("2026-11-24T10:00:00.500000000Z", 1, "d"),
  ].join("\n");
  const { events } = parseMonitorLog(text, {});
  assert.deepEqual(events.map((e) => e.action), ["a", "b", "c", "d", "z"]);
});

test("parseMonitorLog keeps harness, collection method, fidelity and session id", () => {
  const { events } = parseMonitorLog(line({ harness: { name: "codex", collection_method: "otlp" }, event: { action: "x", fidelity: "partial" }, session: { id: "s1" } }), {});
  const { harness, collection_method, fidelity, session_id } = events[0];
  assert.deepEqual({ harness, collection_method, fidelity, session_id }, { harness: "codex", collection_method: "otlp", fidelity: "partial", session_id: "s1" });
});

test("parseFindings refuses non-arrays and findings without a rule id", () => {
  assert.deepEqual(parseFindings(""), []);
  assert.throws(() => parseFindings("{}"), /expected a JSON array/);
  assert.throws(() => parseFindings("[{}]"), /finding 0 has no rule_id/);
  assert.throws(() => parseFindings("[oops"), /not JSON/);
});

const rec = (path, extra = {}) => ({ run_id: "r", serial: 1, syscall: "openat", op: "write", pid: 1, path, in_workspace: false, class: "headline", excluded: null, ...extra });

test("matchWrites: an excluded record of another class counts as excluded, not other", () => {
  const m = matchWrites([rec("/a", { class: "denied", excluded: "monitor" }), rec("/b", { class: "denied" }), rec("/ws/c", { in_workspace: true })], [], {});
  assert.deepEqual(m.excluded, { monitor: 1, model_server: 0, startup: 0 });
  assert.equal(m.other.denied, 1);
  assert.equal(m.in_workspace, 1);
  assert.equal(m.denominator, 0);
  assert.equal(m.rate, null);
});

test("matchWrites: an empty run has a null rate, and unknown matchers, classes or reasons are errors", () => {
  assert.equal(matchWrites([], [], {}).rate, null);
  assert.throws(() => matchWrites([], [], { matcher: "fuzzy" }), /unknown matcher/);
  assert.throws(() => matchWrites([rec("/a", { class: "weird" })], []), /unknown class/);
  assert.throws(() => matchWrites([rec("/a", { excluded: "other" })], []), /unknown exclusion/);
});

test("matchWrites naive: a normalized-equal but differently written file.path is a miss", () => {
  const raw = [{ file: { path: "/x//y" } }, { file: { path: "/z" } }, null, 5];
  const m = matchWrites([rec("/x/y"), rec("/z")], [], { matcher: "naive", rawEvents: raw });
  assert.deepEqual(m.matched, ["/z"]);
  assert.deepEqual(m.missed, ["/x/y"]);
});

const conn = (address, port, extra = {}) => ({ run_id: "r", serial: 1, pid: 1, family: address.includes(":") ? "inet6" : "inet", address, port, class: "egress", excluded: null, ...extra });

test("matchEgress: IPv6 is compared in canonical form; a port in the URL is not compared", () => {
  const m = matchEgress([conn("2001:db8::5", 443), conn("203.0.113.7", 8443)], [
    { command: { command: "curl http://[2001:DB8:0:0::5]:9/x" } },
    { tool: { command: "wget https://user@203.0.113.7:1/" } },
  ]);
  assert.deepEqual(m.matched, ["203.0.113.7:8443", "[2001:db8::5]:443"]);
});

test("matchEgress: server.address in brackets, host:port words, and hostnames from URLs only", () => {
  const m = matchEgress([conn("2001:db8::7", 443), conn("192.0.2.4", 22)], [
    { server: { address: "[2001:db8::7]" } },
    { command: { command: "ssh 192.0.2.4:22 api.example.invalid:443 https://Other.Example.invalid/" } },
  ]);
  assert.equal(m.named, 2);
  assert.deepEqual(m.hostnames, ["Other.Example.invalid"]);
});

test("matchEgress: an IPv4 address does not name its IPv4-mapped IPv6 form or the reverse", () => {
  const m = matchEgress([conn("::ffff:192.0.2.4", 443)], [{ server: { address: "192.0.2.4" } }]);
  assert.equal(m.named, 0);
  const m2 = matchEgress([conn("::ffff:192.0.2.4", 443)], [{ server: { address: "::ffff:c000:204" } }]);
  assert.equal(m2.named, 1);
});

test("matchEgress: unknown classes or reasons are errors", () => {
  assert.throws(() => matchEgress([conn("192.0.2.1", 1, { class: "odd" })], []), /unknown class/);
  assert.throws(() => matchEgress([conn("192.0.2.1", 1, { excluded: "startup" })], []), /unknown exclusion/);
});

test("canonicalInet6: RFC 5952 text, mapped addresses and non-addresses", () => {
  assert.equal(canonicalInet6("2001:0DB8:0000:0000:0000:0000:0000:0001"), "2001:db8::1");
  assert.equal(canonicalInet6("2001:db8:0:1:0:0:0:1"), "2001:db8:0:1::1");
  assert.equal(canonicalInet6("2001:db8:0:1:1:1:1:1"), "2001:db8:0:1:1:1:1:1");
  assert.equal(canonicalInet6("1:0:0:2:0:0:0:3"), "1:0:0:2::3");
  assert.equal(canonicalInet6("::"), "::");
  assert.equal(canonicalInet6("::FFFF:C000:0204"), "::ffff:192.0.2.4");
  assert.equal(canonicalInet6("fe80::1%eth0"), "fe80::1");
  assert.equal(canonicalInet6("192.0.2.1"), null);
  assert.equal(canonicalInet6("example.invalid"), null);
});

test("rate refuses negative, fractional or impossible counts", () => {
  assert.throws(() => rate(-1, 2), /non-negative integer/);
  assert.throws(() => rate(1.5, 2), /non-negative integer/);
  assert.throws(() => rate(3, 2), /larger than denominator/);
});

test("band: one rate, odd and even counts, undefined left out, out-of-range refused", () => {
  assert.deepEqual(band([0.4]), { min: 0.4, median: 0.4, max: 0.4, n: 1 });
  assert.deepEqual(band([1, 0, 0.5]), { min: 0, median: 0.5, max: 1, n: 3 });
  assert.deepEqual(band([undefined, 0, 1, null, 0.2, 0.6]), { min: 0, median: 0.4, max: 1, n: 4 });
  assert.throws(() => band([1.2]), /not in \[0, 1\]/);
  assert.throws(() => band([NaN]), /not in \[0, 1\]/);
  assert.throws(() => band(undefined), /band: no rates/);
});

const S6 = { run_id: "x", git_sha: "0".repeat(40), machine: "m", model_revision: "f".repeat(64), quant: null, runtime: "node v22", date: "2026-11-24T00:00:00Z" };
const COMMON = { harness: "codex", cli_version: "0.172.0", monitor_version: "v1.3.67", split: "dev", scenario_count: 12 };
const TABLE_FIELDS = {
  headline: { scenario: "s", matcher: "naive", numerator: 0, denominator: 0, rate: null, excluded: {}, other: {}, in_workspace: 0, missed: [] },
  headline_band: { matcher: "contract", runs: ["a"], numerator: [1], denominator: [2], band: { min: 0.5, median: 0.5, max: 0.5, n: 1 } },
  write_path: { write_path: "edit", numerator: 1, denominator: 2, rate: 0.5 },
  rule_matrix: { rule_id: "r", scenario: "s", cell: "no_event" },
  egress: { connects: 0, named: 0, missed: [], loopback: 0, failed: 0, excluded: {}, hostnames: [], boundary: "none" },
  startup: { path: "/r/home/.cfg" },
  smoke: { keyless_write: true, requests: 2 },
};

test("makeRow: every table builds, and each of its fields is required", () => {
  for (const [table, extra] of Object.entries(TABLE_FIELDS)) {
    const fields = { ...S6, ...COMMON, ...extra };
    assert.equal(makeRow(table, fields).table, table);
    for (const k of Object.keys(fields)) {
      const { [k]: _gone, ...rest } = fields;
      void _gone;
      assert.throws(() => makeRow(table, rest), new RegExp(`missing field: ${k}$`), `${table} without ${k}`);
    }
  }
});

test("makeRow: an unknown table, a bad rate, cell, matcher or quant is refused; the row is a copy", () => {
  const f = { ...S6, ...COMMON, ...TABLE_FIELDS.write_path };
  assert.throws(() => makeRow("composite", f), /unknown table/);
  assert.throws(() => makeRow("write_path", { ...f, rate: NaN }), /bad field: rate/);
  assert.throws(() => makeRow("write_path", { ...f, quant: "q4" }), /bad field: quant/);
  assert.throws(() => makeRow("rule_matrix", { ...S6, ...COMMON, ...TABLE_FIELDS.rule_matrix, cell: "maybe" }), /bad field: cell/);
  assert.throws(() => makeRow("headline", { ...S6, ...COMMON, ...TABLE_FIELDS.headline, matcher: "fuzzy" }), /bad field: matcher/);
  const nested = { ...S6, ...COMMON, ...TABLE_FIELDS.egress };
  const row = makeRow("egress", { ...nested, table: "headline" });
  assert.equal(row.table, "egress");
  nested.missed.push("changed");
  assert.deepEqual(row.missed, []);
});

const SC = JSON.parse(readFileSync(new URL("../../fixtures/scenarios/dev/dotfile-edit.json", import.meta.url), "utf8"));
const VARS = { WS: "/r/ws", HOME: "/r/home", OUT: "/r/out" };

test("ruleCell: a non-headline record is no write; a rule the scenario is not about is an error", () => {
  const denied = [rec("/r/home/.bashrc", { class: "denied" })];
  assert.equal(ruleCell({ ruleId: "shell-login-dotfile-modified", scenario: SC, vars: VARS, truthRecords: denied, findings: [] }), "no_event");
  assert.equal(ruleCell({ ruleId: "shell-login-dotfile-modified", scenario: SC, vars: VARS, truthRecords: [rec("/r/home/.bashrc")], findings: [] }), "not_fired");
  assert.throws(() => ruleCell({ ruleId: "etc-hosts-modified", scenario: SC, vars: VARS, truthRecords: [], findings: [] }), /not about etc-hosts-modified/);
  assert.throws(() => ruleCell({ ruleId: "shell-login-dotfile-modified", scenario: SC, vars: { WS: "/r/ws" }, truthRecords: [], findings: [] }), /unknown variable \$\{HOME\}/);
});
