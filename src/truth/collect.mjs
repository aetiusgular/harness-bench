// Ground-truth writes and connects of one run's process tree
// (contracts/truth.md, Output record and Connect records; contracts/api.md).

import { parseAuditLog } from "./parse.mjs";
import { normalizeAbsolute, inWorkspace } from "../common/paths.mjs";

const WRITE_FLAGS = 0x243n; // O_WRONLY | O_RDWR | O_CREAT | O_TRUNC
const AT_FDCWD = 0xffffff9cn;
const FORKS = new Set(["clone", "clone3", "fork", "vfork"]);

// contracts/truth.md, Which events are writes. P4 moved open, renameat,
// linkat and symlinkat into the headline (Request for integration in the P2
// PR): coreutils `mv` onto an existing file and `ln` make exactly these calls. `flags` names the flags
// argument; `dirfd` the argument that holds the directory fd for the
// reported name (null: the name is relative to the cwd).
const WRITES = {
  openat: { op: "write", items: ["CREATE", "NORMAL"], cls: "headline", flags: "a2", dirfd: "a0" },
  openat2: { op: "write", items: ["CREATE", "NORMAL"], cls: (nt) => (nt === "CREATE" ? "headline" : "openat2_unclassified"), dirfd: "a0" },
  creat: { op: "write", items: ["CREATE", "NORMAL"], cls: "headline", dirfd: null },
  truncate: { op: "truncate", items: ["NORMAL"], cls: "headline", dirfd: null },
  rename: { op: "rename", items: ["CREATE"], cls: "headline", dirfd: null },
  renameat2: { op: "rename", items: ["CREATE"], cls: "headline", dirfd: "a2" },
  unlink: { op: "unlink", items: ["DELETE"], cls: "headline", dirfd: null },
  unlinkat: { op: "unlink", items: ["DELETE"], cls: "headline", dirfd: "a0" },
  link: { op: "link", items: ["CREATE"], cls: "headline", dirfd: null },
  symlink: { op: "symlink", items: ["CREATE"], cls: "headline", dirfd: null },
  open: { op: "write", items: ["CREATE", "NORMAL"], cls: "headline", flags: "a1", dirfd: null },
  renameat: { op: "rename", items: ["CREATE"], cls: "headline", dirfd: "a2" },
  linkat: { op: "link", items: ["CREATE"], cls: "headline", dirfd: "a2" },
  symlinkat: { op: "symlink", items: ["CREATE"], cls: "headline", dirfd: "a1" },
};

function hexArg(v) {
  if (v === null || v === undefined || !/^[0-9A-Fa-f]+$/.test(v)) return null;
  return BigInt(`0x${v}`);
}

// auditd prints an int argument as its 32-bit two's complement or, on some
// kernels, sign-extended to 64 bits. Both low words are AT_FDCWD.
function isAtFdcwd(v) {
  const n = hexArg(v);
  return n !== null && (n & 0xffffffffn) === AT_FDCWD;
}

// contracts/truth.md, Normalization, steps 3 and 4 (one copy, src/common/paths.mjs).
export const normalizePath = normalizeAbsolute;

function window(ctx) {
  const start = ctx.start ?? -Infinity;
  const end = ctx.end ?? Infinity;
  return (e) => e.ts >= start && e.ts <= end;
}

// The harness's process tree, decided in serial (time) order: root_pid, any
// pid whose parent is in the tree, and any child a tree member's successful
// fork or clone returned. Returns the events of the window with `member` set.
// The walk is in time order (ts, then serial), so a serial that repeats
// across a boot cannot put a child's event ahead of the clone that returned
// it (HB-P3b-r1-C1). The caller keeps serial order for output.
function walkTree(events, ctx) {
  const tree = new Set([Number(ctx.root_pid)]);
  const out = [];
  const timeOrder = [...events].sort((a, b) => a.ts - b.ts || a.serial - b.serial);
  for (const e of timeOrder) {
    if (e.syscall === null || e.pid === null) continue;
    const member = tree.has(e.pid) || (e.ppid !== null && tree.has(e.ppid));
    if (member) {
      tree.add(e.pid);
      if (FORKS.has(e.syscall) && e.success) {
        const child = Number(e.exit);
        if (Number.isSafeInteger(child) && child > 0) tree.add(child);
      }
    }
    out.push({ e, member });
  }
  return out;
}

function exclusion(ex, e, path, { startup }) {
  if (e.exe && (ex.monitor_exe_prefixes ?? []).some((p) => e.exe.startsWith(p))) return "monitor";
  if ((ex.model_server_pids ?? []).map(Number).includes(e.pid)) return "model_server";
  if (startup && path !== null) {
    for (const s of ex.startup_paths ?? []) {
      if (s.endsWith("/") ? path.startsWith(s) : path === s) return "startup";
    }
  }
  return null;
}

function pickItem(paths, wanted) {
  for (const nt of wanted) {
    const hit = paths.find((p) => p.nametype === nt && p.name !== null);
    if (hit) return hit;
  }
  // No item of the expected nametype (a failed call can log UNKNOWN): the
  // last item that is not the parent folder.
  const rest = paths.filter((p) => p.nametype !== "PARENT" && p.name !== null);
  return rest.length ? rest[rest.length - 1] : null;
}

// Serial order for output (contracts/truth.md, Output record).
function parseOrder(set) {
  return [...set].sort((a, b) => a.serial - b.serial || a.ts - b.ts);
}

function events(text, ctx) {
  const inWindow = window(ctx);
  const servers = new Set((ctx.exclude?.model_server_pids ?? []).map(Number));
  const kept = new Set(
    walkTree(parseAuditLog(text).filter(inWindow), ctx)
      .filter(({ e, member }) => member || servers.has(e.pid))
      .map(({ e }) => e),
  );
  return parseOrder(kept);
}

// TruthRecord[] in serial order (contracts/truth.md, Output record).
export function collectWrites(text, context) {
  const ctx = context ?? {};
  const ex = ctx.exclude ?? {};
  const out = [];
  for (const e of events(text, ctx)) {
    const spec = WRITES[e.syscall];
    if (!spec) continue;
    if (spec.flags) {
      const flags = hexArg(e[spec.flags]);
      if (flags === null || (flags & WRITE_FLAGS) === 0n) continue;
    }
    const item = pickItem(e.paths, spec.items);
    if (!item) continue;

    let path;
    let unresolved = false;
    if (item.name.startsWith("/")) path = normalizePath(item.name);
    else if ((spec.dirfd === null || isAtFdcwd(e[spec.dirfd])) && e.cwd && e.cwd.startsWith("/")) {
      path = normalizePath(`${e.cwd}/${item.name}`);
    } else {
      path = item.name;
      unresolved = true;
    }

    let cls;
    if (!e.success) cls = "denied";
    else if (unresolved) cls = "unresolved";
    else cls = typeof spec.cls === "function" ? spec.cls(item.nametype) : spec.cls;

    out.push({
      run_id: ctx.run_id,
      serial: e.serial,
      syscall: e.syscall,
      op: spec.op,
      pid: e.pid,
      path,
      in_workspace: unresolved ? false : inWorkspace(path, ctx.workspace),
      class: cls,
      excluded: exclusion(ex, e, unresolved ? null : path, { startup: true }),
      ts: e.ts,
      exe: e.exe,
      comm: e.comm,
      success: e.success,
      exit: e.exit,
    });
  }
  return out;
}

// RFC 5952 text for 16 address bytes: lowercase, no leading zeros, the
// longest run of two or more zero groups (the first, on a tie) as "::".
// An IPv4-mapped address keeps its dotted tail (RFC 5952 section 5).
export function formatInet6(bytes) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push((bytes[i] << 8) | bytes[i + 1]);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `::ffff:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`;
}

function decodeSaddr(saddr) {
  if (!saddr || !/^(?:[0-9A-Fa-f]{2})+$/.test(saddr)) return null;
  const b = Buffer.from(saddr, "hex");
  if (b.length < 2) return null;
  const family = b.readUInt16LE(0);
  if (family === 2 && b.length >= 8) {
    return { family: "inet", port: b.readUInt16BE(2), address: [...b.subarray(4, 8)].join(".") };
  }
  if (family === 10 && b.length >= 24) {
    return { family: "inet6", port: b.readUInt16BE(2), address: formatInet6(b.subarray(8, 24)) };
  }
  return null;
}

// 127.0.0.0/8 and ::1, plus the unspecified addresses 0.0.0.0 and ::, which
// Linux connects to the local host (HB-P3b-r1-E1), and their IPv4-mapped forms.
function isLoopback({ family, address }) {
  if (family === "inet") return address.startsWith("127.") || address === "0.0.0.0";
  return address === "::1" || address === "::" || address.startsWith("::ffff:127.") || address === "::ffff:0.0.0.0";
}

// ConnectRecord[] in serial order (contracts/truth.md, Connect records).
export function collectConnects(text, context) {
  const ctx = context ?? {};
  const ex = ctx.exclude ?? {};
  const out = [];
  for (const e of events(text, ctx)) {
    if (e.syscall !== "connect") continue;
    const sa = decodeSaddr(e.saddr);
    if (!sa) continue;
    let cls;
    if (!e.success && e.exit !== "-115") cls = "failed";
    else if (isLoopback(sa)) cls = "loopback";
    else cls = "egress";
    out.push({
      run_id: ctx.run_id,
      serial: e.serial,
      pid: e.pid,
      family: sa.family,
      address: sa.address,
      port: sa.port,
      class: cls,
      excluded: exclusion(ex, e, null, { startup: false }),
      ts: e.ts,
      exe: e.exe,
      comm: e.comm,
      success: e.success,
      exit: e.exit,
    });
  }
  return out;
}
