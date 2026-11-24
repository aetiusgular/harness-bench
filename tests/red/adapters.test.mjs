// Lane P3a red tests: harness adapters (contracts/api.md, src/harness/adapters.mjs).
import assert from "node:assert/strict";
import path from "node:path";
import { redTest, json } from "./lib.mjs";
import { adapterFor } from "../../src/harness/adapters.mjs";

const HARNESSES = Object.keys(json("models.lock").harnesses);
const RUN = { workspace: "/tmp/hb-r1/ws", home: "/tmp/hb-r1/home", modelUrl: "http://127.0.0.1:45678", prompt: "Do the scripted task." };
const PARENT = {
  ANTHROPIC_API_KEY: "sk-ant-api03-parent-value-must-not-pass",
  OPENAI_API_KEY: "sk-proj-parent-value-must-not-pass",
  GEMINI_API_KEY: "AIza-parent-value-must-not-pass",
  HB_PARENT_ONLY: "parent-only-value",
};

function commandFor(h) {
  return adapterFor(h).command({ bin: `/opt/hb/${h}`, ...RUN });
}

redTest("P3a-adapter-unknown", "an unknown harness id throws", "harness.adapterFor", async () => {
  assert.throws(() => adapterFor("nope"), /unknown harness nope/);
});

redTest("P3a-adapter-env-clean", "no parent environment value but PATH reaches the harness, and every credential is a dummy", "harness.adapterFor", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, PARENT);
  try {
    for (const h of HARNESSES) {
      const { env } = commandFor(h);
      for (const [k, v] of Object.entries(env)) {
        if (k === "PATH") continue;
        assert.ok(!Object.values(PARENT).includes(v), `${h}: ${k} came from the parent environment`);
        if (/(KEY|TOKEN|SECRET)/.test(k)) assert.match(v, /^hb-dummy-/, `${h}: ${k} is not a dummy credential`);
      }
    }
  } finally {
    for (const k of Object.keys(PARENT)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

redTest("P3a-adapter-points-at-server", "each harness is pointed at the scripted server, runs in the workspace with HOME set to the run home", "harness.adapterFor", async () => {
  for (const h of HARNESSES) {
    const c = commandFor(h);
    assert.equal(c.argv[0], `/opt/hb/${h}`);
    assert.equal(c.cwd, RUN.workspace);
    assert.equal(c.env.HOME, RUN.home);
    const where = [...Object.values(c.env), ...c.argv, ...Object.values(c.files ?? {})].join("\n");
    assert.ok(where.includes(RUN.modelUrl), `${h}: the model URL is not in its env, argv or config files`);
    assert.ok(c.argv.join(" ").includes(RUN.prompt) || Object.values(c.files ?? {}).join("").includes(RUN.prompt), `${h}: the prompt is not passed`);
  }
});

redTest("P3a-adapter-files-scoped", "config files an adapter asks for stay under the run home or the workspace", "harness.adapterFor", async () => {
  for (const h of HARNESSES) {
    for (const f of Object.keys(commandFor(h).files ?? {})) {
      const p = path.resolve(f);
      assert.equal(p, f, `${h}: ${f} is not absolute and normalized`);
      assert.ok(p.startsWith(RUN.home + "/") || p.startsWith(RUN.workspace + "/"), `${h}: ${f} is outside home and workspace`);
    }
  }
});

redTest("P3a-adapter-wire", "each adapter reports the wire format models.lock pins for it", "harness.adapterFor", async () => {
  const lock = json("models.lock").harnesses;
  for (const h of HARNESSES) assert.equal(adapterFor(h).wire, lock[h].wire);
});
