// Lane P3a: harness adapter cases beyond the red tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adapterFor, DUMMY_CREDENTIAL } from "../../src/harness/adapters.mjs";
import { LOCK } from "./lib.mjs";

const RUN = { bin: "/opt/hb/x", workspace: "/tmp/hb-r1/ws", home: "/tmp/hb-r1/home", modelUrl: "http://127.0.0.1:45678/v1", prompt: "Do it; $(touch /tmp/hb-never) 'quoted'" };

test("runEnv goes on top of the adapter's environment", () => {
  for (const h of Object.keys(LOCK.harnesses)) {
    const { env } = adapterFor(h).command({ ...RUN, runEnv: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", HOME: "/tmp/hb-r1/home" } });
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, "http://127.0.0.1:4318", h);
  }
});

test("the prompt is one argv element, never parsed by a shell", () => {
  for (const h of Object.keys(LOCK.harnesses)) assert.ok(adapterFor(h).command(RUN).argv.includes(RUN.prompt), h);
});

test("XDG folders point into the run home", () => {
  for (const h of Object.keys(LOCK.harnesses)) {
    const { env } = adapterFor(h).command(RUN);
    for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) assert.ok(env[k].startsWith(RUN.home + "/"), `${h} ${k}`);
  }
});

test("each harness gets exactly one dummy credential value, and approvals are off", () => {
  const off = { "claude-code": "--dangerously-skip-permissions", codex: "--dangerously-bypass-approvals-and-sandbox", "gemini-cli": "-y" };
  for (const h of Object.keys(LOCK.harnesses)) {
    const c = adapterFor(h).command(RUN);
    const blob = [...Object.values(c.env), ...Object.values(c.files)].join("\n");
    assert.ok(blob.includes(DUMMY_CREDENTIAL), `${h}: no dummy credential`);
    if (off[h]) assert.ok(c.argv.includes(off[h]), `${h}: approvals not off`);
  }
  const oc = JSON.parse(Object.values(adapterFor("opencode").command(RUN).files)[0]);
  assert.deepEqual(oc.permission, { edit: "allow", bash: "allow", external_directory: "allow" });
});

test("the codex config quotes the model URL as a TOML string", () => {
  const { files } = adapterFor("codex").command({ ...RUN, modelUrl: 'http://127.0.0.1:1/v1"\nx = 1' });
  const toml = files["/tmp/hb-r1/home/.codex/config.toml"];
  assert.match(toml, /^base_url = "http:\/\/127\.0\.0\.1:1\/v1\\"\\nx = 1"$/m);
  assert.doesNotMatch(toml, /^x = 1$/m);
});

test("gemini-cli adds the run home and R/out as workspace directories", () => {
  const { argv } = adapterFor("gemini-cli").command(RUN);
  assert.equal(argv[argv.indexOf("--include-directories") + 1], "/tmp/hb-r1/home,/tmp/hb-r1/out");
});

test("a relative workspace or home is refused, and a prototype key is not a harness", () => {
  assert.throws(() => adapterFor("codex").command({ ...RUN, home: "home" }), /must be absolute/);
  assert.throws(() => adapterFor("constructor"), /unknown harness constructor/);
  assert.throws(() => adapterFor("__proto__"), /unknown harness __proto__/);
});
