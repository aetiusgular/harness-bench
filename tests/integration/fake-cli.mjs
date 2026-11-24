#!/usr/bin/env node
// A stand-in agent CLI for the cross-lane tests (not a harness under test).
// It reads ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN as the claude-code
// adapter sets them, offers Bash and Write, runs each tool call the scripted
// server sends (Bash through `sh -c`, Write as a file write), and stops at the
// first text reply. Exit 0 on a clean end, 3 on a protocol error.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const base = process.env.ANTHROPIC_BASE_URL;
if (!base || !process.env.ANTHROPIC_AUTH_TOKEN?.startsWith("hb-dummy-")) process.exit(3);
const tools = [
  { name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Write", description: "write", input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
];
const prompt = process.argv[process.argv.indexOf("-p") + 1] ?? "go";
const messages = [{ role: "user", content: prompt }];
for (let turn = 0; turn < 10; turn++) {
  const r = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_AUTH_TOKEN },
    body: JSON.stringify({ model: "fake-model", max_tokens: 100, stream: false, tools, messages }),
  });
  if (r.status !== 200) process.exit(3);
  const msg = await r.json();
  messages.push({ role: "assistant", content: msg.content });
  const uses = msg.content.filter((c) => c.type === "tool_use");
  if (!uses.length) process.exit(0);
  const results = [];
  for (const u of uses) {
    let out = "ok";
    try {
      if (u.name === "Bash") out = execFileSync("sh", ["-c", u.input.command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      else if (u.name === "Write") writeFileSync(u.input.file_path, u.input.content);
    } catch (e) {
      out = `error: ${e.message}`;
    }
    results.push({ type: "tool_result", tool_use_id: u.id, content: out });
  }
  messages.push({ role: "user", content: results });
}
process.exit(3);
