// auditd log parser: records grouped into events by serial (contracts/truth.md, contracts/api.md).
//
// Reads RAW and ENRICHED logs. In ENRICHED format the interpreted fields
// follow a 0x1d byte; only the raw part before it is read.

// x86_64 syscall numbers for every syscall the rule template names, plus the
// common ones a hand-read log shows. Others are returned as "syscall_<n>".
const SYSCALLS = new Map([
  [0, "read"], [1, "write"], [2, "open"], [3, "close"], [41, "socket"], [42, "connect"],
  [43, "accept"], [49, "bind"], [56, "clone"], [57, "fork"], [58, "vfork"], [59, "execve"],
  [76, "truncate"], [77, "ftruncate"], [82, "rename"], [83, "mkdir"], [84, "rmdir"], [85, "creat"],
  [86, "link"], [87, "unlink"], [88, "symlink"], [257, "openat"], [258, "mkdirat"], [263, "unlinkat"],
  [264, "renameat"], [265, "linkat"], [266, "symlinkat"], [288, "accept4"], [316, "renameat2"],
  [322, "execveat"], [435, "clone3"], [437, "openat2"],
]);

export function syscallName(n) {
  return SYSCALLS.get(n) ?? `syscall_${n}`;
}

// `node=<host> ` may precede `type=` when auditd writes the node name.
const RECORD = /^(?:node=\S+\s+)?type=(\S+)\s+msg=audit\((\d+(?:\.\d+)?):(\d+)\):\s?(.*)$/;
const FIELD = /([A-Za-z0-9_\[\]]+)=("[^"]*"|'[^']*'|\S*)/g;
const HEX = /^(?:[0-9A-Fa-f]{2})+$/;

// Fields auditd writes either quoted (plain text) or as unquoted hex (when
// the text holds a space, a quote or a control byte).
function decode(raw) {
  if (raw === undefined) return null;
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) return raw.slice(1, -1);
  if (raw === "(null)" || raw === "") return null;
  if (HEX.test(raw)) return Buffer.from(raw, "hex").toString("utf8");
  return raw;
}

function fields(body) {
  const out = {};
  for (const m of body.matchAll(FIELD)) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

function num(raw) {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function strip(raw) {
  if (raw === undefined) return null;
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

// EXECVE arguments: a<n>="text" or hex, or, for a long argument, a<n>_len=<n>
// followed by chunks a<n>[0], a<n>[1], ... that are joined before decoding.
function execveArgs(records) {
  const f = Object.assign({}, ...records.map((r) => r.f));
  const argc = num(f.argc) ?? 0;
  const args = [];
  for (let i = 0; i < argc; i++) {
    const key = `a${i}`;
    if (f[key] !== undefined) {
      args.push(decode(f[key]) ?? "");
      continue;
    }
    let joined = "";
    let quoted = false;
    for (let j = 0; f[`${key}[${j}]`] !== undefined; j++) {
      const c = f[`${key}[${j}]`];
      if (c.startsWith('"')) quoted = true;
      joined += quoted ? c.replace(/^"|"$/g, "") : c;
    }
    args.push(quoted ? joined : (decode(joined) ?? ""));
  }
  return args;
}

function buildEvent(serial, ts, records) {
  const ev = {
    serial, ts, syscall: null, success: null, exit: null, a0: null, a1: null, a2: null,
    pid: null, ppid: null, comm: null, exe: null, key: null, cwd: null, paths: [], execve: null, saddr: null,
  };
  const execve = [];
  for (const r of records) {
    const f = r.f;
    switch (r.type) {
      case "SYSCALL": {
        const n = num(f.syscall);
        ev.syscall = n === null ? strip(f.syscall) : syscallName(n);
        ev.success = f.success === "yes";
        ev.exit = strip(f.exit) ?? null;
        ev.a0 = strip(f.a0) ?? null;
        ev.a1 = strip(f.a1) ?? null;
        ev.a2 = strip(f.a2) ?? null;
        ev.pid = num(f.pid);
        ev.ppid = num(f.ppid);
        ev.comm = decode(f.comm);
        ev.exe = decode(f.exe);
        ev.key = decode(f.key)?.replaceAll("\x01", ",") ?? null;
        break;
      }
      case "CWD":
        ev.cwd = decode(f.cwd);
        break;
      case "PATH":
        ev.paths.push({ item: num(f.item), name: decode(f.name), nametype: strip(f.nametype) ?? null });
        break;
      case "EXECVE":
        execve.push(r);
        break;
      case "SOCKADDR":
        ev.saddr = strip(f.saddr) ?? null;
        break;
      default:
        break;
    }
  }
  if (execve.length) ev.execve = execveArgs(execve);
  ev.paths.sort((a, b) => (a.item ?? 0) - (b.item ?? 0));
  return ev;
}

// Event[] in serial order. Records of one event share `<time>:<serial>`;
// they may interleave with other events' records and EOE may be missing.
export function parseAuditLog(text) {
  const groups = new Map();
  for (let line of String(text ?? "").split(/\r?\n/)) {
    const gs = line.indexOf("\x1d");
    if (gs >= 0) line = line.slice(0, gs);
    const m = RECORD.exec(line);
    if (!m) continue;
    const [, type, time, serialText, body] = m;
    const id = `${time}:${serialText}`;
    let g = groups.get(id);
    if (!g) {
      g = { serial: Number(serialText), ts: Number(time), records: [] };
      groups.set(id, g);
    }
    if (type !== "EOE") g.records.push({ type, f: fields(body) });
  }
  return [...groups.values()]
    .sort((a, b) => a.serial - b.serial || a.ts - b.ts)
    .map((g) => buildEvent(g.serial, g.ts, g.records));
}
