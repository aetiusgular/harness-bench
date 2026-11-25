// P5 r2 tests for scripts/eval.sh: the column dispatch forge's run-eval.sh
// uses for this project (HB-P5-r1-C2) and the project-dependency link for the
// box's fresh checkout (HB-P5-r1-C1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmpdir = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "hb-p5sh-")));

// A copy of the repo's eval.sh and lockfiles, with no node_modules and no
// eval.mjs, so nothing past the dispatch and the dependency step can run.
function scratchRepo() {
  const dir = tmpdir();
  mkdirSync(path.join(dir, "scripts"));
  mkdirSync(path.join(dir, "results"));
  copyFileSync(path.join(ROOT, "scripts", "eval.sh"), path.join(dir, "scripts", "eval.sh"));
  for (const f of ["package.json", "package-lock.json"]) copyFileSync(path.join(ROOT, f), path.join(dir, f));
  return dir;
}

function evalSh(dir, env) {
  return spawnSync("bash", [path.join(dir, "scripts", "eval.sh")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, FORGE_PHASE: "P5", ...env },
  });
}

test("eval.sh: the landrun pass forge runs with FORGE_SKIP_COLUMNS=srt runs nothing and exits 0 (HB-P5-r1-C2)", () => {
  const dir = scratchRepo();
  try {
    const r = evalSh(dir, { FORGE_SKIP_COLUMNS: "srt", FORGE_COLUMN: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(path.join(dir, "results", "summary.md"), "utf8"), /srt column/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval.sh: FORGE_COLUMN=srt is this project's column; an unknown column exits 2 (HB-P5-r1-C2)", () => {
  const dir = scratchRepo();
  try {
    const bad = evalSh(dir, { FORGE_COLUMN: "monitor" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /no column monitor/);
    // srt gets past the dispatch to the dependency step (no deps in this prefix).
    const srt = evalSh(dir, { FORGE_COLUMN: "srt", HB_PREFIX: path.join(dir, "prefix") });
    assert.equal(srt.status, 3, srt.stderr);
    assert.doesNotMatch(srt.stderr, /no column/);
    assert.match(srt.stderr, /p5-setup\.sh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval.sh: a fresh checkout links node_modules to <prefix>/deps only when the lockfiles match (HB-P5-r1-C1)", () => {
  const dir = scratchRepo();
  try {
    const prefix = path.join(dir, "prefix");
    const deps = path.join(prefix, "deps");
    mkdirSync(path.join(deps, "node_modules", "derm-workspace"), { recursive: true });
    writeFileSync(path.join(deps, "node_modules", "derm-workspace", "package.json"), "{}\n");
    writeFileSync(path.join(deps, "package-lock.json"), "{}\n"); // stale lock
    const stale = evalSh(dir, { FORGE_COLUMN: "srt", HB_PREFIX: prefix });
    assert.equal(stale.status, 3);
    assert.throws(() => lstatSync(path.join(dir, "node_modules")));
    copyFileSync(path.join(dir, "package-lock.json"), path.join(deps, "package-lock.json"));
    const ok = evalSh(dir, { FORGE_COLUMN: "srt", HB_PREFIX: prefix });
    // eval.mjs is not in the scratch repo, so node fails after the link is made.
    assert.notEqual(ok.status, 3, ok.stderr);
    assert.ok(lstatSync(path.join(dir, "node_modules")).isSymbolicLink());
    assert.equal(realpathSync(path.join(dir, "node_modules")), realpathSync(path.join(deps, "node_modules")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval.sh: a node_modules folder without derm-workspace is refused, not linked into (HB-P5-r2-C1)", () => {
  const dir = scratchRepo();
  try {
    const prefix = path.join(dir, "prefix");
    const deps = path.join(prefix, "deps");
    mkdirSync(path.join(deps, "node_modules", "derm-workspace"), { recursive: true });
    writeFileSync(path.join(deps, "node_modules", "derm-workspace", "package.json"), "{}\n");
    copyFileSync(path.join(dir, "package-lock.json"), path.join(deps, "package-lock.json"));
    mkdirSync(path.join(dir, "node_modules", "other"), { recursive: true });
    const r = evalSh(dir, { FORGE_COLUMN: "srt", HB_PREFIX: prefix });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /node_modules is a folder/);
    assert.throws(() => lstatSync(path.join(dir, "node_modules", "node_modules")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
