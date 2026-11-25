// Startup exclusions from the noop calibration runs (contracts/run.md,
// Startup exclusions). P5.
//
// The pilot showed that the harnesses' start-up writes carry run-varying names:
// `.claude.json.tmp.<pid>.<hex>`, `projects/<encoded run root>/`,
// `/tmp/claude-<uid>/fswatch-probe-<random>/`, sqlite journals. Listing exact
// paths would exclude none of them in the next run. So each calibration path
// is written as a folder (`.../`), widened until it is the same in every run:
//
// 1. Replace the run's R/ws, R/home and R/out with ${WS}, ${HOME}, ${OUT}.
// 2. Take the path's parent folder. A file directly in ${HOME}, ${OUT} or a
//    top-level folder (`/tmp`, `/etc`, `/dev`) stays an exact path, so a
//    startup write to `${HOME}/.bashrc` would never exclude `${HOME}/.zshrc`.
// 3. A folder seen in fewer than all runs is replaced by its parent, while
//    the parent is deeper than the limits in step 2.
// 4. Drop folders covered by another, and refuse any entry that would cover
//    a scenario's expected write or the run root's parent (`tmpRoot`): those
//    are listed in `refused` and never written as exclusions.
import path from "node:path";

const VARS = ["WS", "HOME", "OUT"];

export function toVars(p, vars) {
  for (const k of VARS) {
    const v = vars[k];
    if (p === v) return `\${${k}}`;
    if (p.startsWith(v + "/")) return `\${${k}}` + p.slice(v.length);
  }
  return p;
}

// A folder (ending in /) or file is "shallow" when it must not be widened:
// ${HOME}/, ${OUT}/, ${WS}/, or a folder with one component outside R.
function tooShallow(folder) {
  if (/^\$\{(HOME|OUT|WS)\}\/$/.test(folder)) return true;
  if (folder.startsWith("${")) return false;
  return folder.split("/").filter(Boolean).length <= 1;
}

function parentFolder(p) {
  const d = path.posix.dirname(p.endsWith("/") ? p.slice(0, -1) : p);
  return d === "/" ? "/" : d + "/";
}

// runs: [{ vars, paths: [absolute out-of-workspace headline paths] }]
// guard: { expect: [paths with ${...} variables], tmpRoot }
export function startupExclusions(runs, { expect = [], tmpRoot = null } = {}) {
  if (!Array.isArray(runs) || runs.length === 0) throw new Error("startupExclusions: no calibration runs");
  const perRun = runs.map(({ vars, paths }) => {
    const s = new Set();
    for (const p of paths) {
      const v = toVars(p, vars);
      if (v.startsWith("${WS}")) continue;
      const folder = parentFolder(v);
      s.add(tooShallow(folder) ? v : folder);
    }
    return s;
  });
  const all = new Set(perRun.flatMap((s) => [...s]));
  const widened = new Set();
  for (let e of all) {
    // Widen a folder until it appears (or is covered) in every run.
    while (e.endsWith("/") && !perRun.every((s) => [...s].some((x) => x === e || x.startsWith(e)))) {
      const up = parentFolder(e);
      if (tooShallow(up)) break;
      e = up;
    }
    widened.add(e);
  }
  const sorted = [...widened].sort();
  const kept = sorted.filter((e) => !sorted.some((o) => o !== e && o.endsWith("/") && e.startsWith(o)));
  const covers = (e, p) => (e.endsWith("/") ? p.startsWith(e) || p + "/" === e : p === e);
  const refused = [];
  const out = [];
  for (const e of kept) {
    const hit = expect.find((p) => covers(e, p));
    const tmpHit = tmpRoot && e.endsWith("/") && !e.startsWith("${") && (tmpRoot + "/").startsWith(e);
    if (hit || tmpHit) refused.push({ path: e, reason: hit ? `covers expected write ${hit}` : `covers the run root's parent ${tmpRoot}` });
    else out.push(e);
  }
  return { paths: out, refused };
}
