// Lane P3a: scripted model server cases beyond the red tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, classify } from "../../src/model/server.mjs";
import { pickTool, offeredTools } from "../../src/model/tools.mjs";
import { substitute } from "../../src/model/vars.mjs";
import { R1, scenario, json, postJson } from "./lib.mjs";

const ANT = json("fixtures/model/anthropic-turn.json");
const GEM = json("fixtures/model/gemini-turn.json");
const CHAT = json("fixtures/model/chat-turn.json");
const RESP = json("fixtures/model/responses-turn.json");

test("an unknown variable in setup or expect is refused too, not only in steps", async () => {
  for (const field of ["setup", "expect", "expect_denied"]) {
    const sc = { ...scenario("plain-shell"), [field]: [{ file: "${HOME}/a", path: "${R}/x", content: "" }] };
    await assert.rejects(startServer({ scenario: sc, harness: "claude-code", vars: R1 }), /unknown variable \$\{R\}/, field);
  }
});

test("substitute replaces every known variable at any depth and leaves other text", () => {
  assert.deepEqual(substitute({ a: ["${WS}/x", { b: "${OUT}${HOME}" }], n: 3, s: "$HOME {WS}" }, R1), { a: ["/tmp/hb-r1/ws/x", { b: "/tmp/hb-r1/out/tmp/hb-r1/home" }], n: 3, s: "$HOME {WS}" });
  assert.throws(() => substitute("${}", R1), /unknown variable \$\{\}/);
  assert.throws(() => substitute("${WS}", { HOME: "/h" }), /unknown variable \$\{WS\}/);
});

test("a multi-step scenario sends its steps in order, one per turn, then final_text", async () => {
  const sc = { ...scenario("plain-shell"), steps: [{ action: "shell", command: "true 1" }, { action: "edit", path: "${OUT}/b", content: "x" }, { action: "shell", command: "true 3" }] };
  const server = await startServer({ scenario: sc, harness: "claude-code", vars: R1 });
  try {
    const bodies = [];
    for (let i = 0; i < 4; i++) bodies.push((await postJson(`${server.url}/v1/messages`, { ...ANT, stream: false })).text);
    assert.match(bodies[0], /"Bash"[\s\S]*true 1/);
    assert.match(bodies[1], /"Write"[\s\S]*\/tmp\/hb-r1\/out\/b/);
    assert.match(bodies[2], /true 3/);
    assert.match(bodies[3], /"end_turn"/);
    assert.doesNotMatch(bodies[3], /tool_use/);
    assert.deepEqual(server.transcript.map((t) => [t.step, t.action, t.tool, t.status]), [[0, "shell", "Bash", "sent"], [1, "edit", "Write", "sent"], [2, "shell", "Bash", "sent"]]);
  } finally {
    await server.close();
  }
});

test("an unsupported step ends the script: later steps are never sent", async () => {
  const sc = { ...scenario("plain-shell"), steps: [{ action: "edit", path: "${OUT}/a", content: "x" }, { action: "shell", command: "true later" }] };
  const server = await startServer({ scenario: sc, harness: "codex", vars: R1 });
  try {
    const a = await postJson(`${server.url}/responses`, RESP);
    const b = await postJson(`${server.url}/responses`, RESP);
    assert.match(a.text, /hb: no native edit tool/);
    assert.doesNotMatch(b.text, /true later|function_call"/);
    assert.match(b.text, /done/);
    assert.deepEqual(server.transcript, [{ step: 0, action: "edit", tool: null, status: "unsupported" }]);
  } finally {
    await server.close();
  }
});

test("Gemini side requests (generateContent, countTokens) never advance the script", async () => {
  const server = await startServer({ scenario: scenario("plain-shell"), harness: "gemini-cli", vars: R1 });
  try {
    const base = `${server.url}/v1beta/models/fake-model`;
    assert.equal((await postJson(`${base}:generateContent`, GEM)).status, 200);
    assert.equal((await postJson(`${base}:countTokens`, GEM)).status, 200);
    const t = await postJson(`${base}:streamGenerateContent?alt=sse`, GEM);
    assert.match(t.text, /run_shell_command/);
    assert.deepEqual(server.requests.map((r) => r.kind), ["side", "side", "turn"]);
  } finally {
    await server.close();
  }
});

test("Anthropic count_tokens is a side request; a chat request with no tools gets text", async () => {
  const a = await startServer({ scenario: scenario("plain-shell"), harness: "claude-code", vars: R1 });
  const c = await startServer({ scenario: scenario("plain-shell"), harness: "opencode", vars: R1 });
  try {
    assert.equal((await postJson(`${a.url}/v1/messages/count_tokens`, ANT)).status, 200);
    const side = await postJson(`${c.url}/chat/completions`, { ...CHAT, tools: [], stream: false });
    assert.equal(side.status, 200);
    assert.doesNotMatch(side.text, /tool_calls"\s*:\s*\[/);
    assert.deepEqual(a.requests.map((r) => r.kind), ["side"]);
    assert.deepEqual(c.requests.map((r) => r.kind), ["side"]);
    assert.deepEqual(c.transcript, []);
  } finally {
    await a.close();
    await c.close();
  }
});

test("every request is recorded, 404s included, with method, url and kind", async () => {
  const server = await startServer({ scenario: scenario("plain-shell"), harness: "codex", vars: R1 });
  try {
    assert.equal((await postJson(`${server.url}/models`, null, "GET")).status, 200);
    assert.equal((await postJson(`${server.url}/chat/completions`, CHAT)).status, 404);
    assert.equal((await postJson(`${server.url.replace(/\/v1$/, "")}/responses`, RESP)).status, 404);
    assert.deepEqual(server.requests.map((r) => [r.method, r.url, r.kind]), [["GET", "/v1/models", "other"], ["POST", "/v1/chat/completions", "other"], ["POST", "/responses", "other"]]);
    assert.deepEqual(server.transcript, []);
  } finally {
    await server.close();
  }
});

test("classify routes each wire's own paths only", () => {
  assert.equal(classify("anthropic-messages", "POST", "/v1/messages?beta=true", ANT), "turn");
  assert.equal(classify("anthropic-messages", "POST", "/v1/messagesx", ANT), null);
  assert.equal(classify("gemini", "POST", "/v1beta/models/m:streamGenerateContent?alt=sse", GEM), "turn");
  assert.equal(classify("gemini", "POST", "/v1beta/models/m:streamGenerateContent", { contents: [] }), "side");
  assert.equal(classify("gemini", "GET", "/v1beta/models/m:generateContent", GEM), null);
  assert.equal(classify("openai-chat", "POST", "/v1/responses", RESP), null);
});

test("pickTool reads argument names from the offered schema, and an argv-typed shell gets sh -c", () => {
  const offered = [{ name: "shell", schema: { properties: { command: { type: "array", items: { type: "string" } } } } }];
  assert.deepEqual(pickTool({ action: "shell", command: "echo hi" }, offered), { tool: "shell", args: { command: ["sh", "-c", "echo hi"] } });
  assert.deepEqual(pickTool({ action: "edit", path: "/x", content: "c" }, [{ name: "write", schema: { properties: { path: {}, content: {} } } }]), { tool: "write", args: { path: "/x", content: "c" } });
  assert.equal(pickTool({ action: "shell", command: "x" }, [{ name: "Read", schema: {} }]), null);
  assert.throws(() => pickTool({ action: "fly" }, []), /unknown action fly/);
});

test("offeredTools reads each wire's tool list", () => {
  assert.deepEqual(offeredTools("anthropic-messages", ANT).map((t) => t.name), ["Bash", "Write", "Read"]);
  assert.deepEqual(offeredTools("openai-responses", RESP).map((t) => t.name), ["exec_command", "write_stdin", "view_image"]);
  assert.deepEqual(offeredTools("openai-chat", CHAT).map((t) => t.name), ["bash", "write", "read"]);
  assert.deepEqual(offeredTools("gemini", GEM).map((t) => t.name), ["run_shell_command", "write_file", "read_file"]);
  assert.deepEqual(offeredTools("gemini", null), []);
});

test("close() is idempotent and frees the port", async () => {
  const server = await startServer({ scenario: scenario("plain-shell"), harness: "gemini-cli", vars: R1 });
  await Promise.all([server.close(), server.close()]);
  await assert.rejects(fetch(`${server.url}/v1beta/models/m:countTokens`, { method: "POST", body: "{}" }));
});

test("a start that cannot listen rejects and leaves no inner fake listening (HB-P3a-r1-C2, P4)", async () => {
  const first = await startServer({ scenario: scenario("plain-shell"), harness: "claude-code", vars: R1 });
  const handles = () => process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;
  const before = handles();
  try {
    await assert.rejects(startServer({ scenario: scenario("plain-shell"), harness: "claude-code", vars: R1, port: first.port }), /EADDRINUSE/);
    // Closed handles leave the list on a later tick; without the fix the count stays up.
    for (let i = 0; i < 50 && handles() > before; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(handles(), before);
  } finally {
    await first.close();
  }
});
