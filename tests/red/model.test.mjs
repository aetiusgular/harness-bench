// Lane P3a red tests: the scripted model server (contracts/api.md, src/model/server.mjs).
import assert from "node:assert/strict";
import { redTest, json, scenario, R1, toolCalls, post } from "./lib.mjs";
import { startServer } from "../../src/model/server.mjs";

const lock = json("models.lock");
const wire = (h) => lock.harnesses[h].wire;
const BODY = {
  "anthropic-messages": json("fixtures/model/anthropic-turn.json"),
  "openai-responses": json("fixtures/model/responses-turn.json"),
  "openai-chat": json("fixtures/model/chat-turn.json"),
  gemini: json("fixtures/model/gemini-turn.json"),
};

async function withServer(h, sc, fn) {
  const server = await startServer({ scenario: scenario(sc), harness: h, vars: R1 });
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

async function turn(server, h, opts) {
  const r = await post(server, wire(h), BODY[wire(h)], opts);
  assert.equal(r.status, 200, r.body.slice(0, 300));
  return r;
}

redTest("P3a-model-loopback", "the server listens on 127.0.0.1 only and close() frees it", "model.startServer", async () => {
  const server = await startServer({ scenario: scenario("plain-shell"), harness: "claude-code", vars: R1 });
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  await server.close();
  await assert.rejects(fetch(`${server.url}/v1/messages`, { method: "POST", body: "{}" }));
});

redTest("P3a-model-anthropic-edit", "an edit step becomes the Write tool with the resolved path and the whole content", "model.startServer", async () => {
  await withServer("claude-code", "dotfile-edit", async (server) => {
    const calls = toolCalls((await turn(server, "claude-code")).body);
    assert.deepEqual(calls, [{ name: "Write", args: { file_path: "/tmp/hb-r1/home/.bashrc", content: "export HB_MARK=1\n" } }]);
  });
});

redTest("P3a-model-anthropic-stream", "a streamed turn is Server-Sent Events carrying the tool call and message_stop", "model.startServer", async () => {
  await withServer("claude-code", "plain-shell", async (server) => {
    const r = await turn(server, "claude-code", { stream: true });
    assert.match(r.type, /text\/event-stream/);
    assert.match(r.body, /message_stop/);
    const calls = toolCalls(r.body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "Bash");
    assert.match(calls[0].args.command, /\/tmp\/hb-r1\/out\/notes\.txt/);
  });
});

redTest("P3a-model-side-request", "a side request (no tools, a title) gets text and does not advance the script", "model.startServer", async () => {
  await withServer("claude-code", "dotfile-edit", async (server) => {
    const side = await post(server, "anthropic-messages", json("fixtures/model/anthropic-side.json"));
    assert.equal(side.status, 200);
    assert.deepEqual(toolCalls(side.body), []);
    const calls = toolCalls((await turn(server, "claude-code")).body);
    assert.equal(calls[0]?.name, "Write");
    assert.equal(server.requests.filter((r) => r.kind === "side").length, 1);
    assert.equal(server.requests.filter((r) => r.kind === "turn").length, 1);
  });
});

redTest("P3a-model-final-text", "after the last step the next turn gets final_text and no tool call", "model.startServer", async () => {
  await withServer("claude-code", "dotfile-edit", async (server) => {
    await turn(server, "claude-code");
    const r = await turn(server, "claude-code");
    assert.deepEqual(toolCalls(r.body), []);
    assert.match(r.body, /done/);
    assert.match(r.body, /end_turn/);
  });
});

redTest("P3a-model-responses-shell", "a shell step on the Responses wire becomes the shell tool the request offered", "model.startServer", async () => {
  await withServer("codex", "plain-shell", async (server) => {
    const calls = toolCalls((await turn(server, "codex")).body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "exec_command");
    assert.match(JSON.stringify(calls[0].args), /\/tmp\/hb-r1\/out\/notes\.txt/);
  });
});

redTest("P3a-model-gemini-shell", "a shell step on the Gemini wire (streamGenerateContent, as the CLI sends turns) becomes run_shell_command", "model.startServer", async () => {
  await withServer("gemini-cli", "plain-shell", async (server) => {
    const calls = toolCalls((await turn(server, "gemini-cli", { stream: true })).body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "run_shell_command");
    assert.match(calls[0].args.command, /\/tmp\/hb-r1\/out\/notes\.txt/);
  });
});

redTest("P3a-model-chat-edit", "an edit step on the chat wire becomes the write tool with its own argument names", "model.startServer", async () => {
  await withServer("opencode", "plain-edit", async (server) => {
    const calls = toolCalls((await turn(server, "opencode")).body);
    assert.deepEqual(calls, [{ name: "write", args: { filePath: "/tmp/hb-r1/out/notes.txt", content: "hb fixture\n" } }]);
  });
});

redTest("P3a-model-no-edit-tool", "an edit step for a harness that offers no write-file tool is recorded unsupported, never sent as shell", "model.startServer", async () => {
  await withServer("codex", "plain-edit", async (server) => {
    const r = await turn(server, "codex");
    assert.deepEqual(toolCalls(r.body), []);
    assert.match(r.body, /hb: no native edit tool/);
    assert.equal(server.transcript[0]?.status, "unsupported");
  });
});

redTest("P3a-model-vars", "a scenario string with an unknown variable is refused at start", "model.startServer", async () => {
  const sc = { ...scenario("plain-shell"), steps: [{ action: "shell", command: "printf x > ${NOPE}/a" }] };
  await assert.rejects(Promise.resolve().then(() => startServer({ scenario: sc, harness: "codex", vars: R1 })), /unknown variable \$\{NOPE\}/);
});

redTest("P3a-model-unknown-harness", "a harness missing from models.lock is refused", "model.startServer", async () => {
  await assert.rejects(Promise.resolve().then(() => startServer({ scenario: scenario("plain-shell"), harness: "nope", vars: R1 })), /unknown harness nope/);
});

redTest("P3a-model-404", "an unknown route gets a 404 and the server keeps answering", "model.startServer", async () => {
  await withServer("opencode", "plain-shell", async (server) => {
    const r = await fetch(`${server.url}/nope`);
    assert.equal(r.status, 404);
    const calls = toolCalls((await turn(server, "opencode")).body);
    assert.equal(calls[0]?.name, "bash");
  });
});
