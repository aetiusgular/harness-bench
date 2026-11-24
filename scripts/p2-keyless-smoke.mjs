#!/usr/bin/env node
// P2 keyless smoke: can each pinned harness CLI (models.lock) be driven by a
// local fake model server, with no key, to write one file outside its
// workspace? SPEC.md: a harness whose keyless path fails in P2 is dropped.
//
//   node scripts/p2-keyless-smoke.mjs <cli-prefix> [harness ...]
//
// <cli-prefix> is a folder where the pinned CLIs are installed, e.g. after
//   npm install --prefix <cli-prefix> @anthropic-ai/claude-code@<v> @openai/codex@<v> @google/gemini-cli@<v> opencode-ai@<v>
// It uses derm's fake servers (package.json), not this repo's scripted
// server (lane P3a builds that). Each run gets a fresh temp root with ws/,
// home/ and out/, an environment built from nothing but PATH, and a dummy
// credential. It prints one results row per harness (table "smoke",
// contracts/results.md) and appends them to results/p2-keyless-smoke.jsonl.

import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as M from "derm-workspace/tests/cli-contract/lib/fakeMessages.mjs";
import * as R from "derm-workspace/tests/cli-contract/lib/fakeResponses.mjs";
import * as G from "derm-workspace/tests/cli-contract/lib/fakeGemini.mjs";
import * as C from "derm-workspace/tests/cli-contract/lib/fakeChat.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(path.join(ROOT, "models.lock"), "utf8"));
const [prefix, ...only] = process.argv.slice(2);
if (!prefix) {
  console.error("usage: node scripts/p2-keyless-smoke.mjs <cli-prefix> [harness ...]");
  process.exit(2);
}
const DUMMY = "hb-dummy-not-a-key";

function machine() {
  const cpu = /model name\s*:\s*(.+)/.exec(readFileSync("/proc/cpuinfo", "utf8"))?.[1]?.trim() ?? "unknown cpu";
  const mem = /MemTotal:\s*(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
  let gpu = "";
  try {
    gpu = execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { encoding: "utf8" }).trim().split("\n").join(", ");
  } catch {}
  return [cpu, mem ? `${Math.round(Number(mem) / 1048576)} GiB RAM` : "", gpu].filter(Boolean).join("; ");
}

function run(bin, args, opts) {
  return new Promise((resolve) => {
    const c = spawn(bin, args, opts);
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => c.kill("SIGKILL"), 120000);
    c.on("close", (status) => {
      clearTimeout(t);
      resolve({ status, out, err });
    });
    c.stdin.end();
  });
}

async function smoke(h) {
  const root = mkdtempSync(path.join(os.tmpdir(), `hb-smoke-${h}-`));
  const ws = path.join(root, "ws");
  const home = path.join(root, "home");
  const out = path.join(root, "out");
  for (const d of [ws, home, out]) mkdirSync(d, { recursive: true });
  const target = path.join(out, "notes.txt");
  const cmd = `printf hb > ${target}`;
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share") };
  const bin = path.join(prefix, "node_modules/.bin", lock.harnesses[h].bin);
  let fake;
  let args;
  let step = 0;
  if (h === "claude-code") {
    fake = await M.startFakeMessages({ script: (b) => (M.isSideRequest(b) || !b.tools?.length ? [M.textBlock("t")] : step++ === 0 ? [M.toolUse("Bash", { command: cmd, description: "write" })] : [M.textBlock("done")]) });
    Object.assign(env, { ANTHROPIC_BASE_URL: fake.baseUrl, ANTHROPIC_AUTH_TOKEN: DUMMY, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    args = ["-p", "Do the scripted task.", "--dangerously-skip-permissions", "--model", "claude-sonnet-4-5"];
  } else if (h === "codex") {
    fake = await R.startFakeResponses({ script: (b) => (R.isSideRequest(b) ? [R.text("t")] : step++ === 0 ? [R.call("exec_command", { cmd })] : [R.text("done")]) });
    const ch = path.join(home, ".codex");
    mkdirSync(ch, { recursive: true });
    writeFileSync(path.join(ch, "config.toml"), [`model_provider = "hb"`, `model = "fake-model"`, `[model_providers.hb]`, `name = "hb"`, `base_url = "${fake.baseUrl}"`, `wire_api = "responses"`, "requires_openai_auth = false", "supports_websockets = false", "request_max_retries = 0", "stream_max_retries = 0", "[analytics]", "enabled = false", ""].join("\n"));
    env.CODEX_HOME = ch;
    args = ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "Do the scripted task."];
  } else if (h === "gemini-cli") {
    fake = await G.startFakeGemini({ script: () => (step++ === 0 ? [G.functionCall("run_shell_command", { command: cmd })] : [G.text("done")]) });
    mkdirSync(path.join(home, ".gemini"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
    Object.assign(env, { GEMINI_API_KEY: DUMMY, GOOGLE_GEMINI_BASE_URL: fake.baseUrl, GEMINI_CLI_TRUST_WORKSPACE: "true", GEMINI_CLI_NO_RELAUNCH: "true" });
    args = ["-p", "Do the scripted task.", "-y"];
  } else if (h === "opencode") {
    fake = await C.startFakeChat({ script: (b, n) => (n === 0 ? { tool: "bash", args: { command: cmd, description: "write" } } : { text: "done" }) });
    const cfg = { provider: { hb: { npm: "@ai-sdk/openai-compatible", name: "hb", options: { baseURL: fake.baseUrl, apiKey: DUMMY }, models: { "fake-model": { name: "fake-model" } } } }, model: "hb/fake-model", permission: { edit: "allow", bash: "allow", external_directory: "allow" }, autoupdate: false, share: "disabled" };
    writeFileSync(path.join(ws, "opencode.json"), JSON.stringify(cfg));
    args = ["run", "Do the scripted task."];
  } else throw new Error(`unknown harness ${h}`);
  const version = (await run(bin, ["--version"], { env })).out.trim();
  const r = await run(bin, args, { cwd: ws, env });
  const written = existsSync(target);
  const requests = fake.requests.length;
  await fake.close?.();
  rmSync(root, { recursive: true, force: true });
  return { h, version, status: r.status, written, requests, err: r.err.slice(-300) };
}

const git_sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const split = /^split-sha256: ([0-9a-f]{64})$/m.exec(readFileSync(path.join(ROOT, "contracts/eval.md"), "utf8"))[1];
const mach = machine();
for (const h of only.length ? only : Object.keys(lock.harnesses)) {
  const s = await smoke(h);
  const row = {
    run_id: `smoke-${h}-${randomBytes(4).toString("hex")}`,
    git_sha,
    machine: mach,
    model_revision: split,
    quant: null,
    runtime: `node ${process.version}; derm fake servers ${lock.derm.commit.slice(0, 12)}`,
    date: new Date().toISOString(),
    table: "smoke",
    harness: h,
    cli_version: lock.harnesses[h].version,
    cli_version_reported: s.version,
    keyless_write: s.written,
    exit_status: s.status,
    requests: s.requests,
  };
  console.log(JSON.stringify(row));
  if (!s.written) console.error(`${h}: no write. stderr tail: ${s.err}`);
  appendFileSync(path.join(ROOT, "results/p2-keyless-smoke.jsonl"), JSON.stringify(row) + "\n");
}
