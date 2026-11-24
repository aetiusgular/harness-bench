// P2 contract checks. These pass from P2 on; they guard the frozen split,
// the fixtures' internal consistency and the seams the lanes build against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const SPLITS = ["dev", "heldout"];
const scenarios = SPLITS.flatMap((split) =>
  readdirSync(path.join(ROOT, "fixtures/scenarios", split)).sort().map((f) => ({ split, file: f, doc: json(`fixtures/scenarios/${split}/${f}`) })),
);
const VARS = new Set(["WS", "HOME", "OUT"]);

function strings(o, out = []) {
  if (typeof o === "string") out.push(o);
  else if (Array.isArray(o)) o.forEach((v) => strings(v, out));
  else if (o && typeof o === "object") Object.values(o).forEach((v) => strings(v, out));
  return out;
}

test("split hash in contracts/eval.md matches fixtures/scenarios", () => {
  const want = /^split-sha256: ([0-9a-f]{64})$/m.exec(read("contracts/eval.md"))[1];
  const lines = execFileSync("bash", ["-c", "cd fixtures/scenarios && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(createHash("sha256").update(lines).digest("hex"), want);
});

test("calibration hash in contracts/eval.md matches noop.json", () => {
  const want = /^calibration-sha256: ([0-9a-f]{64})/m.exec(read("contracts/eval.md"))[1];
  assert.equal(createHash("sha256").update(readFileSync(path.join(ROOT, "fixtures/calibration/noop.json"))).digest("hex"), want);
});

test("every scenario follows hb-scenario/1", () => {
  const ids = new Set();
  for (const { split, file, doc } of [...scenarios, { split: "calibration", file: "noop.json", doc: json("fixtures/calibration/noop.json") }]) {
    assert.equal(doc.schema, "hb-scenario/1", file);
    assert.match(doc.id, /^[a-z0-9-]+$/);
    assert.equal(`${doc.id}.json`, file);
    assert.equal(doc.split, split, file);
    assert.ok(!ids.has(doc.id), `duplicate id ${doc.id}`);
    ids.add(doc.id);
    assert.ok(["edit", "shell", "program", "control"].includes(doc.write_path), file);
    for (const k of ["about_rules", "setup", "steps", "expect", "expect_denied"]) assert.ok(Array.isArray(doc[k]), `${file}: ${k}`);
    assert.equal(typeof doc.prompt, "string");
    assert.equal(typeof doc.final_text, "string");
    for (const s of doc.steps) {
      if (s.action === "edit") assert.deepEqual(Object.keys(s).sort(), ["action", "content", "path"], file);
      else if (s.action === "shell") assert.deepEqual(Object.keys(s).sort(), ["action", "command"], file);
      else assert.fail(`${file}: unknown action ${s.action}`);
    }
    for (const s of doc.setup) assert.ok(("mkdir" in s && Object.keys(s).length === 1) || ("file" in s && "content" in s && Object.keys(s).length === 2), file);
    for (const e of [...doc.expect, ...doc.expect_denied]) assert.ok(["write", "truncate", "rename", "unlink", "link", "symlink"].includes(e.op), `${file}: op ${e.op}`);
    for (const str of strings(doc)) for (const [, v] of str.matchAll(/\$\{([^}]*)\}/g)) assert.ok(VARS.has(v), `${file}: unknown variable \${${v}}`);
  }
});

test("the split has the shape contracts/scenario.md states", () => {
  assert.equal(scenarios.length, 24);
  for (const split of SPLITS) {
    const mine = scenarios.filter((s) => s.split === split).map((s) => s.doc);
    const count = (p) => mine.filter((d) => d.write_path === p).length;
    assert.deepEqual([count("edit"), count("shell"), count("program"), count("control")], [3, 4, 4, 1], split);
    for (const t of ["dotfile", "authkeys", "autostart", "envrc", "hosts", "plain", "rename", "unlink", "control"]) {
      assert.ok(mine.some((d) => d.target === t), `${split} has no ${t}`);
    }
  }
  const rules = new Set(scenarios.flatMap((s) => s.doc.about_rules));
  assert.deepEqual([...rules].sort(), ["autostart-unit-file-installed", "direnv-envrc-modified", "etc-hosts-modified", "shell-login-dotfile-modified", "ssh-authorized-keys-modified"]);
  for (const s of scenarios) {
    if (s.doc.write_path === "control") assert.ok(strings(s.doc.steps).every((x) => !x.includes("${HOME}") && !x.includes("${OUT}")), `${s.file} writes outside the workspace`);
    if (s.doc.write_path === "program") assert.ok(s.doc.setup.some((x) => x.file === "${WS}/tools/task.sh"), `${s.file}: no program in the workspace`);
  }
});

test("the monitor fixture's expected numbers agree with the ground-truth fixture", () => {
  const truth = json("fixtures/audit/basic.expected.json").records;
  const want = json("fixtures/monitor/basic.expected.json");
  const denom = new Set(truth.filter((r) => r.class === "headline" && r.excluded === null && !r.in_workspace).map((r) => r.path));
  assert.equal(denom.size, want.contract.denominator);
  assert.deepEqual([...denom].sort(), [...want.contract.matched, ...want.contract.missed].sort());
  const named = new Set(Object.values(want.paths_by_sequence).flat());
  assert.deepEqual(want.contract.matched, [...denom].filter((p) => named.has(p)).sort());
  assert.equal(want.contract.numerator, want.contract.matched.length);
  assert.equal(want.contract.rate, want.contract.numerator / want.contract.denominator);
  const raw = read("fixtures/monitor/basic.runtime.jsonl").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const naive = [...denom].filter((p) => raw.some((e) => e.file?.path === p)).sort();
  assert.deepEqual(naive, want.naive.matched);
  const count = (f) => truth.filter(f).length;
  assert.deepEqual(want.excluded, { monitor: count((r) => r.excluded === "monitor"), model_server: count((r) => r.excluded === "model_server"), startup: count((r) => r.excluded === "startup") });
  assert.deepEqual(want.other, Object.fromEntries(["other_syscall", "openat2_unclassified", "denied", "unresolved"].map((c) => [c, count((r) => r.class === c && r.excluded === null)])));
  assert.equal(want.in_workspace, count((r) => r.in_workspace && r.class === "headline" && r.excluded === null));
});

test("the audit fixture covers every serial the expected file names", () => {
  const log = read("fixtures/audit/basic.log");
  for (const r of json("fixtures/audit/basic.expected.json").records) assert.match(log, new RegExp(`:${r.serial}\\): `), `serial ${r.serial}`);
});

test("the connect fixtures agree: SOCKADDR bytes, classes and the egress counts", () => {
  const log = read("fixtures/audit/connect.log");
  const recs = json("fixtures/audit/connect.expected.json").records;
  const want = json("fixtures/monitor/connect.expected.json");
  for (const r of recs) {
    const m = new RegExp(`type=SOCKADDR msg=audit\\([0-9.]+:${r.serial}\\): saddr=([0-9A-F]+)`).exec(log);
    assert.ok(m, `no SOCKADDR for serial ${r.serial}`);
    const b = Buffer.from(m[1], "hex");
    assert.equal(b.readUInt16LE(0), r.family === "inet" ? 2 : 10, `family ${r.serial}`);
    assert.equal(b.readUInt16BE(2), r.port, `port ${r.serial}`);
    const addr = r.family === "inet" ? [...b.subarray(4, 8)].join(".") : null;
    if (addr) assert.equal(addr, r.address, `address ${r.serial}`);
  }
  const ep = (r) => (r.family === "inet6" ? `[${r.address}]:${r.port}` : `${r.address}:${r.port}`);
  const distinct = (f) => new Set(recs.filter(f).map(ep)).size;
  assert.equal(distinct((r) => r.class === "egress" && r.excluded === null), want.connects);
  assert.equal(distinct((r) => r.class === "loopback" && r.excluded === null), want.loopback);
  assert.equal(distinct((r) => r.class === "failed" && r.excluded === null), want.failed);
  assert.deepEqual(want.excluded, { monitor: distinct((r) => r.excluded === "monitor"), model_server: distinct((r) => r.excluded === "model_server") });
  assert.deepEqual([...want.matched, ...want.missed].sort(), [...new Set(recs.filter((r) => r.class === "egress" && r.excluded === null).map(ep))].sort());
  assert.equal(want.named, want.matched.length);
});

test("the rule template names every syscall contracts/truth.md classifies", () => {
  const rules = read("contracts/audit.rules.template");
  for (const sc of ["openat", "openat2", "open", "creat", "truncate", "rename", "renameat", "renameat2", "unlink", "unlinkat", "link", "linkat", "symlink", "symlinkat", "execve", "clone", "connect"]) {
    assert.match(rules, new RegExp(`-S [a-z0-9,]*\\b${sc}\\b`), sc);
  }
  assert.ok(rules.includes("@UID@"));
});

test("every seam in contracts/api.md is exported by its module", async () => {
  const api = read("contracts/api.md");
  const seams = { "src/model/server.mjs": ["startServer"], "src/harness/adapters.mjs": ["adapterFor"], "src/truth/rules.mjs": ["renderRules"], "src/truth/parse.mjs": ["parseAuditLog"], "src/truth/collect.mjs": ["collectWrites", "collectConnects"], "src/score/monitor.mjs": ["parseMonitorLog", "commandPaths", "parseFindings"], "src/score/match.mjs": ["matchWrites", "matchEgress"], "src/score/band.mjs": ["rate", "band"], "src/score/rows.mjs": ["makeRow"], "src/score/rulematrix.mjs": ["ruleCell"] };
  for (const [file, names] of Object.entries(seams)) {
    assert.ok(api.includes(file), `api.md does not name ${file}`);
    const mod = await import(path.join(ROOT, file));
    for (const n of names) assert.equal(typeof mod[n], "function", `${file} does not export ${n}`);
  }
});

test("models.lock pins four harnesses with known wire formats", () => {
  const lock = json("models.lock");
  assert.deepEqual(Object.keys(lock.harnesses).sort(), ["claude-code", "codex", "gemini-cli", "opencode"]);
  for (const h of Object.values(lock.harnesses)) {
    assert.match(h.version, /^\d+\.\d+\.\d+$/);
    assert.ok(["anthropic-messages", "openai-responses", "openai-chat", "gemini"].includes(h.wire));
  }
});

test("the pinned derm dependency provides the fake model servers", async () => {
  for (const f of ["fakeMessages", "fakeResponses", "fakeChat", "fakeGemini"]) {
    const mod = await import(`derm-workspace/tests/cli-contract/lib/${f}.mjs`);
    assert.ok(Object.keys(mod).some((k) => k.startsWith("startFake")), f);
  }
});

test("the red-test manifest lists every lane and only P3 lanes", () => {
  const m = json("tests/red/manifest.json");
  const lanes = new Set(m.tests.map((t) => t.lane));
  assert.deepEqual([...lanes].sort(), ["P3a", "P3b", "P3c"]);
  for (const t of m.tests) assert.ok(existsSync(path.join(ROOT, t.cmd.split(" ").at(-1))), t.id);
});
