// Scripted, keyless model server: anthropic-messages, openai-responses, openai-chat and gemini wire formats.
// Lane P3a (contracts/api.md, contracts/scenario.md).
//
// One front server listens on `host`. It records every request, answers
// unknown routes with a 404 and forwards the model routes to one of derm's
// fake servers (imported through package.json, not copied), which does the
// wire encoding. The fake's `script` callback is where a request becomes the
// next scenario step, the final text, or a side reply.

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as M from "derm-workspace/tests/cli-contract/lib/fakeMessages.mjs";
import * as R from "derm-workspace/tests/cli-contract/lib/fakeResponses.mjs";
import * as G from "derm-workspace/tests/cli-contract/lib/fakeGemini.mjs";
import * as C from "derm-workspace/tests/cli-contract/lib/fakeChat.mjs";
import { substitute } from "./vars.mjs";
import { offeredTools, pickTool, NO_EDIT_TEXT, NO_SHELL_TEXT } from "./tools.mjs";

const LOCK = JSON.parse(readFileSync(fileURLToPath(new URL("../../models.lock", import.meta.url)), "utf8"));
const SIDE_TEXT = "hb scripted";

// Which routes a wire answers, and what kind each request is. `kind` is
// "turn" (offers tools: the script advances), "side" (a title, a summary, a
// token count: the script does not advance) or "other" (a model list).
function turnBody(wire, body) {
  if (offeredTools(wire, body).length === 0) return false;
  if (wire === "anthropic-messages") return !M.isSideRequest(body);
  if (wire === "openai-responses") return !R.isSideRequest(body);
  return true;
}

export function classify(wire, method, url, body) {
  const pathOnly = url.split("?")[0];
  const offers = turnBody(wire, body);
  if (wire === "anthropic-messages") {
    if (method === "POST" && pathOnly === "/v1/messages/count_tokens") return "side";
    if (method === "POST" && pathOnly === "/v1/messages") return offers ? "turn" : "side";
    return null;
  }
  if (wire === "openai-responses") {
    if (method === "GET" && pathOnly === "/v1/models") return "other";
    if (method === "POST" && pathOnly === "/v1/responses") return offers ? "turn" : "side";
    return null;
  }
  if (wire === "openai-chat") {
    if (method === "GET" && pathOnly === "/v1/models") return "other";
    if (method === "POST" && pathOnly === "/v1/chat/completions") return offers ? "turn" : "side";
    return null;
  }
  if (wire === "gemini") {
    const m = /^\/v1beta\/models\/[^/:]+:(streamGenerateContent|generateContent|countTokens)$/.exec(pathOnly);
    if (method !== "POST" || !m) return null;
    return m[1] === "streamGenerateContent" && offers ? "turn" : "side";
  }
  return null;
}

// The reply for one request in the neutral form { text } or { tool, args }.
function makeScript(scenario, wire, transcript) {
  let next = 0;
  return function reply(body) {
    if (next >= scenario.steps.length) return { text: scenario.final_text ?? "" };
    const i = next++;
    const step = scenario.steps[i];
    const tool = pickTool(step, offeredTools(wire, body));
    if (!tool) {
      transcript.push({ step: i, action: step.action, tool: null, status: "unsupported" });
      // The text ends the harness's turn, so no later step is sent.
      next = scenario.steps.length;
      return { text: step.action === "edit" ? NO_EDIT_TEXT : NO_SHELL_TEXT };
    }
    transcript.push({ step: i, action: step.action, tool: tool.tool, status: "sent" });
    return tool;
  };
}

async function startFake(wire, isTurn, reply) {
  if (wire === "anthropic-messages") {
    return M.startFakeMessages({
      script: (b) => {
        if (!isTurn(b)) return [M.textBlock(SIDE_TEXT)];
        const r = reply(b);
        return [r.tool ? M.toolUse(r.tool, r.args) : M.textBlock(r.text)];
      },
    });
  }
  if (wire === "openai-responses") {
    return R.startFakeResponses({
      script: (b) => {
        if (!isTurn(b)) return [R.text(SIDE_TEXT)];
        const r = reply(b);
        return [r.tool ? R.call(r.tool, r.args) : R.text(r.text)];
      },
    });
  }
  if (wire === "openai-chat") {
    // derm's chat fake calls the script only for requests that offer tools.
    return C.startFakeChat({ script: (b) => (isTurn(b) ? reply(b) : { text: SIDE_TEXT }) });
  }
  if (wire === "gemini") {
    // Only :streamGenerateContent reaches the script; derm answers the rest.
    return G.startFakeGemini({
      script: (b) => {
        if (!isTurn(b)) return [G.text(SIDE_TEXT)];
        const r = reply(b);
        return [r.tool ? G.functionCall(r.tool, r.args) : G.text(r.text)];
      },
    });
  }
  throw new Error(`unknown wire ${wire}`);
}

function forward(fakePort, req, raw, res) {
  return new Promise((resolve) => {
    const headers = { "content-type": req.headers["content-type"] ?? "application/json", "content-length": Buffer.byteLength(raw) };
    const up = http.request({ host: "127.0.0.1", port: fakePort, method: req.method, path: req.url, headers, agent: false }, (r) => {
      const h = { ...r.headers };
      delete h.connection;
      delete h["transfer-encoding"];
      res.writeHead(r.statusCode ?? 502, h);
      r.pipe(res);
      r.on("end", resolve);
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `hb: model fake unreachable: ${e.message}` } }));
      resolve();
    });
    up.end(raw);
  });
}

export async function startServer({ scenario, harness, vars, host = "127.0.0.1", port = 0 } = {}) {
  const entry = LOCK.harnesses[harness];
  if (!Object.hasOwn(LOCK.harnesses, harness) || !entry) throw new Error(`unknown harness ${harness}`);
  const wire = entry.wire;
  const sc = {
    ...scenario,
    setup: substitute(scenario.setup ?? [], vars),
    steps: substitute(scenario.steps ?? [], vars),
    expect: substitute(scenario.expect ?? [], vars),
    expect_denied: substitute(scenario.expect_denied ?? [], vars),
  };

  const requests = [];
  const transcript = [];
  const isTurn = (b) => turnBody(wire, b);
  const fake = await startFake(wire, isTurn, makeScript(sc, wire, transcript));
  const fakePort = fake.port ?? Number(new URL(fake.baseUrl).port);

  const front = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const url = req.url ?? "";
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = { unparsed: raw.slice(0, 2000) };
        }
      }
      const kind = classify(wire, req.method, url, body);
      requests.push({ at: Date.now(), method: req.method, url, kind: kind ?? "other", body });
      if (!kind) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "not_found_error", message: `hb: no route ${req.method} ${url}` } }));
        return;
      }
      await forward(fakePort, req, raw, res);
    });
  });
  await new Promise((resolve, reject) => {
    front.once("error", reject);
    front.listen(port, host, resolve);
  });
  const bound = front.address().port;
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${bound}`;
  const url = wire === "openai-responses" || wire === "openai-chat" ? `${base}/v1` : base;
  let closed;
  return {
    url,
    port: bound,
    requests,
    transcript,
    close() {
      closed ??= (async () => {
        front.closeAllConnections?.();
        await new Promise((r) => front.close(() => r()));
        await fake.close();
      })();
      return closed;
    },
  };
}
