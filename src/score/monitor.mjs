// Reader for the monitor's runtime JSONL log and scan findings (contracts/monitor.md).
import { commandWords, argvToCommand, normalizePath } from "./words.mjs";

const TOOL_COMMAND_KEYS = ["file_path", "filePath", "path", "target_file", "old_path", "new_path"];
const JSON_COMMAND_KEYS = ["command", "cmd"];

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// A word is a path when it follows a file redirection, contains a /, or
// starts with ~. An option (leading -) is a path only through `=<path>`.
function wordIsPath(w) {
  return w.includes("/") || w.startsWith("~");
}

function rawCommandPaths(command) {
  const out = [];
  for (const { value: w, redirect } of commandWords(command)) {
    if (redirect) {
      out.push(w);
      continue;
    }
    if (w.startsWith("-")) {
      const eq = w.indexOf("=");
      if (eq >= 0) {
        const v = w.slice(eq + 1);
        if (v && wordIsPath(v)) out.push(v);
      }
      continue;
    }
    if (wordIsPath(w)) out.push(w);
  }
  return out;
}

export function commandPaths(command, { home, base } = {}) {
  const seen = new Set();
  for (const p of rawCommandPaths(command)) {
    const n = normalizePath(p, { home, base });
    if (n !== null) seen.add(n);
  }
  return [...seen];
}

// P4 (HB-P3c-r1-E2): a JSON `tool.command` object's `command` or `cmd`
// value is a command line. A string is read as one; an array of strings is
// an argv and is read as the command line it runs.
export function jsonCommandLines(parsed) {
  const lines = [];
  for (const k of JSON_COMMAND_KEYS) {
    const v = parsed[k];
    if (typeof v === "string" && v !== "") lines.push(v);
    else if (Array.isArray(v) && v.length && v.every((a) => typeof a === "string")) lines.push(argvToCommand(v));
  }
  return lines;
}

// The paths one parsed JSON line names, as written, with how to read each:
// "path" (taken whole) or "command" (a command line).
function namedPieces(o) {
  const pieces = [];
  const str = (v) => typeof v === "string" && v !== "";
  if (str(o.file?.path)) pieces.push(["path", o.file.path]);
  if (str(o.tool?.path)) pieces.push(["path", o.tool.path]);
  if (str(o.tool?.command)) {
    let parsed;
    try {
      parsed = JSON.parse(o.tool.command);
    } catch {
      parsed = undefined;
    }
    if (isObject(parsed)) {
      for (const k of TOOL_COMMAND_KEYS) if (str(parsed[k])) pieces.push(["path", parsed[k]]);
      for (const line of jsonCommandLines(parsed)) pieces.push(["command", line]);
    } else pieces.push(["command", o.tool.command]);
  }
  if (str(o.command?.command)) pieces.push(["command", o.command.command]);
  const parsedCommands = o.command?.parsed_commands;
  if (Array.isArray(parsedCommands)) {
    for (const pc of parsedCommands) {
      const fw = pc?.file_writes;
      if (!Array.isArray(fw)) continue;
      for (const w of fw) if (str(w?.path)) pieces.push(["path", w.path]);
    }
  }
  return pieces;
}

// Sort key for an RFC 3339 timestamp with up to nine fraction digits.
// Returns null when it does not parse.
function timeKey(ts) {
  if (typeof ts !== "string") return null;
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:?\d\d)$/i.exec(ts);
  if (!m) return null;
  const ms = Date.parse(m[1] + m[3].toUpperCase());
  if (Number.isNaN(ms)) return null;
  return [Math.floor(ms / 1000), Number((m[2] ?? "").padEnd(9, "0"))];
}

function compareEvents(a, b) {
  const ka = a._key;
  const kb = b._key;
  if (ka && kb) {
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
  } else if (ka || kb) return ka ? -1 : 1; // unparseable timestamps last
  else if (a.timestamp !== b.timestamp) return String(a.timestamp) < String(b.timestamp) ? -1 : 1;
  const sa = typeof a.sequence === "number" ? a.sequence : Infinity;
  const sb = typeof b.sequence === "number" ? b.sequence : Infinity;
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

export function parseMonitorLog(text, { home, workspace } = {}) {
  const events = [];
  let bad_lines = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      bad_lines++;
      continue;
    }
    if (!isObject(o)) {
      bad_lines++;
      continue;
    }
    const base = typeof o.session?.working_directory === "string" && o.session.working_directory.startsWith("/") ? o.session.working_directory : workspace;
    const paths = new Set();
    for (const [kind, value] of namedPieces(o)) {
      if (kind === "path") {
        const n = normalizePath(value, { home, base });
        if (n !== null) paths.add(n);
      } else for (const p of commandPaths(value, { home, base })) paths.add(p);
    }
    events.push({
      timestamp: o.timestamp ?? null,
      sequence: o.sequence ?? null,
      action: o.event?.action ?? null,
      harness: o.harness?.name ?? null,
      collection_method: o.harness?.collection_method ?? null,
      fidelity: o.event?.fidelity ?? null,
      session_id: o.session?.id ?? null,
      paths: [...paths],
      _key: timeKey(o.timestamp),
    });
  }
  events.sort(compareEvents); // Array.prototype.sort is stable: ties keep line order
  for (const e of events) delete e._key;
  return { events, bad_lines };
}

export function parseFindings(text) {
  const s = String(text ?? "").trim();
  if (s === "") return [];
  let v;
  try {
    v = JSON.parse(s);
  } catch (err) {
    throw new Error(`parseFindings: not JSON (${err.message})`);
  }
  if (v === null) return [];
  if (!Array.isArray(v)) throw new Error("parseFindings: expected a JSON array of findings");
  return v.map((f, i) => {
    if (!isObject(f) || typeof f.rule_id !== "string" || f.rule_id === "") throw new Error(`parseFindings: finding ${i} has no rule_id`);
    return f;
  });
}
