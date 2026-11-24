// Neutral actions to the tool the harness offered (contracts/scenario.md,
// Neutral actions). The choice is made from the tools in the request, not
// from the harness id, so a CLI that renames a tool fails loudly as
// `unsupported` instead of being sent a call it does not know.

export const NO_EDIT_TEXT = "hb: no native edit tool";
export const NO_SHELL_TEXT = "hb: no shell tool";
const DESCRIPTION = "hb scripted step";

// Native write-file tools, by name, as each pinned CLI offers them.
const EDIT_TOOLS = ["Write", "write_file", "write"];
// Shell tools. Codex 0.172.0 offers exec_command and refuses `shell`
// (DECISIONS.md, P2); `shell` stays last for older Codex builds.
const SHELL_TOOLS = ["Bash", "run_shell_command", "bash", "exec_command", "shell"];

/** The function tools a request offers: [{ name, schema }]. */
export function offeredTools(wire, body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (wire === "anthropic-messages") return tools.filter((t) => t?.name && !t.type?.startsWith?.("web_")).map((t) => ({ name: t.name, schema: t.input_schema ?? {} }));
  if (wire === "openai-responses") return tools.filter((t) => t?.type === "function" && t.name).map((t) => ({ name: t.name, schema: t.parameters ?? {} }));
  if (wire === "openai-chat") return tools.filter((t) => t?.function?.name).map((t) => ({ name: t.function.name, schema: t.function.parameters ?? {} }));
  if (wire === "gemini") return tools.flatMap((t) => t?.functionDeclarations ?? []).filter((f) => f?.name).map((f) => ({ name: f.name, schema: f.parametersJsonSchema ?? f.parameters ?? {} }));
  return [];
}

function props(schema) {
  return schema && typeof schema.properties === "object" && schema.properties ? schema.properties : {};
}

function firstKey(p, keys, fallback) {
  return keys.find((k) => Object.hasOwn(p, k)) ?? fallback;
}

function isArrayType(s) {
  const t = s?.type;
  return t === "array" || (Array.isArray(t) && t.includes("array")) || String(t).toUpperCase() === "ARRAY";
}

/** { tool, args } for a step, or null when the request offers no fitting tool. */
export function pickTool(step, offered) {
  const byName = new Map(offered.map((t) => [t.name, t]));
  if (step.action === "edit") {
    const t = EDIT_TOOLS.map((n) => byName.get(n)).find(Boolean);
    if (!t) return null;
    const p = props(t.schema);
    const pathKey = firstKey(p, ["file_path", "filePath", "path"], t.name === "write" ? "filePath" : "file_path");
    return { tool: t.name, args: { [pathKey]: step.path, content: step.content } };
  }
  if (step.action === "shell") {
    const t = SHELL_TOOLS.map((n) => byName.get(n)).find(Boolean);
    if (!t) return null;
    const p = props(t.schema);
    const key = firstKey(p, ["command", "cmd"], t.name === "exec_command" ? "cmd" : "command");
    const args = { [key]: isArrayType(p[key]) ? ["sh", "-c", step.command] : step.command };
    if (Object.hasOwn(p, "description")) args.description = DESCRIPTION;
    return { tool: t.name, args };
  }
  throw new Error(`unknown action ${step.action}`);
}
