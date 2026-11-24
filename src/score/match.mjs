// Join of ground truth with the monitor's events by path (contracts/monitor.md, The headline join).
import { rate } from "./band.mjs";
import { shellTokens } from "./words.mjs";
import { isIPv4, isIPv6 } from "node:net";

const OTHER = ["other_syscall", "openat2_unclassified", "denied", "unresolved"];
const sorted = (set) => [...set].sort();

export function matchWrites(truthRecords, monitorEvents, { matcher = "contract", rawEvents = [] } = {}) {
  if (matcher !== "contract" && matcher !== "naive") throw new Error(`matchWrites: unknown matcher ${matcher}`);
  const excluded = { monitor: new Set(), model_server: new Set(), startup: new Set() };
  const other = Object.fromEntries(OTHER.map((k) => [k, new Set()]));
  const inWorkspace = new Set();
  const denominator = new Set();
  // Column order: an excluded record goes to its reason whatever its class;
  // then a non-headline class; then in-workspace; the rest is the denominator.
  for (const r of truthRecords ?? []) {
    if (r.excluded !== null && r.excluded !== undefined) {
      if (!(r.excluded in excluded)) throw new Error(`matchWrites: unknown exclusion ${r.excluded}`);
      excluded[r.excluded].add(r.path);
    } else if (r.class !== "headline") {
      if (!(r.class in other)) throw new Error(`matchWrites: unknown class ${r.class}`);
      other[r.class].add(r.path);
    } else if (r.in_workspace) inWorkspace.add(r.path);
    else denominator.add(r.path);
  }
  const named = new Set();
  if (matcher === "contract") {
    for (const e of monitorEvents ?? []) for (const p of e?.paths ?? []) named.add(p);
  } else {
    for (const o of rawEvents ?? []) if (typeof o?.file?.path === "string") named.add(o.file.path);
  }
  const matched = new Set();
  const missed = new Set();
  for (const p of denominator) (named.has(p) ? matched : missed).add(p);
  return {
    numerator: matched.size,
    denominator: denominator.size,
    rate: rate(matched.size, denominator.size),
    matched: sorted(matched),
    missed: sorted(missed),
    excluded: Object.fromEntries(Object.entries(excluded).map(([k, s]) => [k, s.size])),
    other: Object.fromEntries(Object.entries(other).map(([k, s]) => [k, s.size])),
    in_workspace: inWorkspace.size,
  };
}

// RFC 5952 text for an IPv6 address, with an IPv4-mapped address as
// ::ffff:a.b.c.d (the form lane P3b writes). null when not IPv6.
export function canonicalInet6(a) {
  if (typeof a !== "string") return null;
  let s = a.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!isIPv6(s)) return null;
  s = s.toLowerCase();
  // An embedded dotted IPv4 tail becomes its two 16-bit groups.
  s = s.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) => `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`);
  let groups;
  if (s.includes("::")) {
    const [l, r] = s.split("::");
    const L = l ? l.split(":") : [];
    const R = r ? r.split(":") : [];
    groups = [...L, ...Array(8 - L.length - R.length).fill("0"), ...R];
  } else groups = s.split(":");
  groups = groups.map((g) => parseInt(g, 16));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `::ffff:${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  let best = [-1, 0];
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best[1] < 2) return hex.join(":");
  return hex.slice(0, best[0]).join(":") + "::" + hex.slice(best[0] + best[1]).join(":");
}

// An address as compared: IPv4 as written, IPv6 in canonical form.
function canonicalAddress(a) {
  if (typeof a !== "string") return null;
  const bare = a.replace(/^\[|\]$/g, "");
  if (isIPv4(bare)) return bare;
  return canonicalInet6(bare);
}

// The host of a word that is a URL, or of `<address>:<port>`, and whether it
// was a URL. null when the word is neither.
function wordHost(w) {
  const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(w);
  if (url) {
    const auth = url[1].replace(/^.*@/, "");
    if (auth.startsWith("[")) {
      const end = auth.indexOf("]");
      return end > 0 ? { host: auth.slice(1, end), url: true } : null;
    }
    const host = auth.replace(/:\d*$/, "");
    return host ? { host, url: true } : null;
  }
  const v6 = /^\[([^\]]+)\]:\d+$/.exec(w);
  if (v6) return { host: v6[1], url: false };
  const hp = /^([^:/\[\]]+):\d+$/.exec(w);
  if (hp) return { host: hp[1], url: false };
  return null;
}

const endpoint = (r) => (r.family === "inet6" ? `[${r.address}]:${r.port}` : `${r.address}:${r.port}`);

export function matchEgress(connectRecords, rawEvents) {
  const byClass = { egress: new Map(), loopback: new Set(), failed: new Set() };
  const excluded = { monitor: new Set(), model_server: new Set() };
  for (const r of connectRecords ?? []) {
    const ep = endpoint(r);
    if (r.excluded !== null && r.excluded !== undefined) {
      if (!(r.excluded in excluded)) throw new Error(`matchEgress: unknown exclusion ${r.excluded}`);
      excluded[r.excluded].add(ep);
    } else if (r.class === "egress") byClass.egress.set(ep, canonicalAddress(r.address) ?? r.address);
    else if (r.class === "loopback" || r.class === "failed") byClass[r.class].add(ep);
    else throw new Error(`matchEgress: unknown class ${r.class}`);
  }
  const namedAddrs = new Set();
  const hostnames = new Set();
  const note = (host, fromUrlOrServer) => {
    const c = canonicalAddress(host);
    if (c) namedAddrs.add(c);
    else if (fromUrlOrServer && host) hostnames.add(host);
  };
  for (const o of rawEvents ?? []) {
    if (o === null || typeof o !== "object") continue;
    if (typeof o.server?.address === "string" && o.server.address !== "") note(o.server.address, true);
    for (const cmd of [o.tool?.command, o.command?.command]) {
      if (typeof cmd !== "string") continue;
      for (const t of shellTokens(cmd)) {
        if (t.type !== "word") continue;
        const h = wordHost(t.value);
        if (h) note(h.host, h.url);
      }
    }
  }
  const matched = new Set();
  const missed = new Set();
  for (const [ep, addr] of byClass.egress) (namedAddrs.has(addr) ? matched : missed).add(ep);
  return {
    connects: byClass.egress.size,
    named: matched.size,
    matched: sorted(matched),
    missed: sorted(missed),
    loopback: byClass.loopback.size,
    failed: byClass.failed.size,
    excluded: { monitor: excluded.monitor.size, model_server: excluded.model_server.size },
    hostnames: sorted(hostnames),
  };
}
