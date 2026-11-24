// Shared helpers for the P2 red tests. Lanes do not edit tests/red/.
//
// redTest(id, caseText, stub, fn) registers a node:test test named `id`.
// tests/red/manifest.json is generated from these calls by
// tests/red/build-manifest.mjs: each entry runs only its own test and
// expects, while the lane is unbuilt, the stub's "HB not implemented: <stub>".

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function redTest(id, caseText, stub, fn) {
  void caseText;
  void stub;
  test(id, fn);
}

export function text(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

export function json(rel) {
  return JSON.parse(text(rel));
}

export function scenario(id) {
  for (const split of ["dev", "heldout", "calibration"]) {
    const rel = split === "calibration" ? `fixtures/calibration/${id}.json` : `fixtures/scenarios/${split}/${id}.json`;
    try {
      return json(rel);
    } catch {}
  }
  throw new Error(`no scenario ${id}`);
}

// Run r1 of the fixtures (fixtures/audit/basic.context.json).
export const R1 = { WS: "/tmp/hb-r1/ws", HOME: "/tmp/hb-r1/home", OUT: "/tmp/hb-r1/out" };

// Every tool call in a model server reply, whatever the wire format:
// Anthropic tool_use blocks, Responses function_call items, chat
// tool_calls and Gemini functionCall parts. Streaming replies are read
// from their `data:` lines; Anthropic's input_json_delta pieces are joined.
export function toolCalls(bodyText) {
  const objs = [];
  const trimmed = bodyText.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      objs.push(JSON.parse(trimmed));
    } catch {}
  }
  if (!objs.length) {
    for (const line of bodyText.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (!m || m[1] === "[DONE]") continue;
      try {
        objs.push(JSON.parse(m[1]));
      } catch {}
    }
  }
  const calls = [];
  const partial = new Map();
  const parseArgs = (a) => {
    if (a && typeof a === "object") return a;
    try {
      return JSON.parse(a);
    } catch {
      return a;
    }
  };
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.type === "content_block_start" && o.content_block?.type === "tool_use") {
      partial.set(o.index, { name: o.content_block.name, json: "", input: o.content_block.input });
      return;
    }
    if (o.type === "content_block_delta" && o.delta?.type === "input_json_delta") {
      const p = partial.get(o.index);
      if (p) p.json += o.delta.partial_json ?? "";
      return;
    }
    if (o.type === "tool_use" && o.name) calls.push({ name: o.name, args: parseArgs(o.input) });
    else if (o.type === "function_call" && o.name) calls.push({ name: o.name, args: parseArgs(o.arguments) });
    else if (o.function?.name && !o.type?.startsWith?.("response.")) calls.push({ name: o.function.name, args: parseArgs(o.function.arguments) });
    else if (o.functionCall?.name) calls.push({ name: o.functionCall.name, args: parseArgs(o.functionCall.args) });
    for (const v of Object.values(o)) walk(v);
  };
  objs.forEach(walk);
  for (const p of partial.values()) {
    const args = p.json ? parseArgs(p.json) : p.input;
    calls.push({ name: p.name, args });
  }
  // A streamed Responses or chat reply can repeat one call across events.
  const seen = new Set();
  return calls.filter((c) => {
    const k = JSON.stringify(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// POST a fixture request body to the server's endpoint for its wire format.
export async function post(server, wire, body, { stream } = {}) {
  const b = structuredClone(body);
  let url;
  if (wire === "anthropic-messages") url = `${server.url}/v1/messages`;
  else if (wire === "openai-responses") url = `${server.url}/responses`;
  else if (wire === "openai-chat") url = `${server.url}/chat/completions`;
  else url = `${server.url}/v1beta/models/fake-model:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  if (wire !== "gemini") b.stream = Boolean(stream);
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
}
