// Live check of lane P3a: each pinned CLI (models.lock), driven by this
// repo's scripted server (src/model/) through its adapter (src/harness/),
// does dev scenarios with no key. It checks the scenario's expected file,
// not auditd; that is P3b and P5.
//
//   HB_CLI_PREFIX=<folder with the pinned CLIs in node_modules/.bin> node --test tests/model/live.test.mjs
//
// Without HB_CLI_PREFIX it is skipped, so ci never spawns a CLI (DECISIONS.md, P2).
// Install: npm install --prefix <folder> <npm>@<version> for each harness in models.lock.
// HB_LIVE_HARNESSES=codex,opencode limits the harnesses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "../../src/model/server.mjs";
import { adapterFor } from "../../src/harness/adapters.mjs";
import { substitute } from "../../src/model/vars.mjs";
import { LOCK, scenario } from "./lib.mjs";

const PREFIX = process.env.HB_CLI_PREFIX;
const ONLY = (process.env.HB_LIVE_HARNESSES ?? "").split(",").filter(Boolean);
// Dev scenarios only: one per write path, plus the no-op calibration.
const SCENARIOS = ["plain-shell", "dotfile-edit", "dotfile-program", "noop"];

function run(argv, { env, cwd }) {
  return new Promise((resolve) => {
    const c = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => c.kill("SIGKILL"), 180000);
    c.on("close", (status) => {
      clearTimeout(t);
      resolve({ status, out, err });
    });
  });
}

async function once(h, id) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `hb-live-${h}-${id}-`)));
  const vars = { WS: path.join(root, "ws"), HOME: path.join(root, "home"), OUT: path.join(root, "out") };
  for (const d of Object.values(vars)) mkdirSync(d, { recursive: true });
  const sc = scenario(id);
  for (const s of substitute(sc.setup, vars)) {
    if (s.mkdir) mkdirSync(s.mkdir, { recursive: true });
    if (s.file) {
      mkdirSync(path.dirname(s.file), { recursive: true });
      writeFileSync(s.file, s.content, { mode: 0o644 });
    }
  }
  const server = await startServer({ scenario: sc, harness: h, vars });
  try {
    const c = adapterFor(h).command({ bin: path.join(PREFIX, "node_modules/.bin", LOCK.harnesses[h].bin), workspace: vars.WS, home: vars.HOME, modelUrl: server.url, prompt: sc.prompt });
    for (const [f, text] of Object.entries(c.files)) {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = await run(c.argv, c);
    const expect = substitute(sc.expect, vars).map((e) => e.path);
    const transcript = server.transcript.map((t) => t.status);
    return { status: r.status, written: expect.map((p) => existsSync(p)), expect, transcript, turns: server.requests.filter((q) => q.kind === "turn").length, err: r.err.slice(-600), root };
  } finally {
    await server.close();
  }
}

for (const h of Object.keys(LOCK.harnesses)) {
  if (ONLY.length && !ONLY.includes(h)) continue;
  for (const id of SCENARIOS) {
    test(`live ${h} ${id}`, { skip: !PREFIX && "HB_CLI_PREFIX is not set" }, async (t) => {
      const r = await once(h, id);
      t.diagnostic(JSON.stringify({ harness: h, scenario: id, status: r.status, transcript: r.transcript, turns: r.turns, written: r.written }));
      try {
        if (r.transcript.includes("unsupported")) {
          // DECISIONS.md, P2: a harness with no native write tool records the step unsupported.
          assert.deepEqual(r.written, r.expect.map(() => false), `${h} ${id}: unsupported step but the file exists`);
        } else {
          assert.ok(r.turns >= 1 || id === "noop", `${h} ${id}: no turn reached the server`);
          assert.deepEqual(r.written, r.expect.map(() => true), `${h} ${id}: expected writes missing. stderr: ${r.err}`);
        }
      } finally {
        rmSync(r.root, { recursive: true, force: true });
      }
    });
  }
}
