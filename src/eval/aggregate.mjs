// Band and write-path rows from per-run headline rows (contracts/results.md,
// tables headline_band and write_path). P5.
//
// For one harness, split and matcher, repeat k's numerator and denominator
// are sums over that repeat's scenarios. The band is over the repeats' rates.
// A repeat whose denominator is 0 has rate null and is left out of the band
// (results.md, Band). Runs listed in `dropped` (a timed-out harness, an audit
// window split by two log rotations, a root pid no execve record anchored) are left out of every sum and named in
// the row, never silently.
import { createHash } from "node:crypto";
import { band, rate } from "../score/band.mjs";
import { makeRow } from "../score/rows.mjs";

const key = (...xs) => xs.join("\u0000");

export function bandId(harness, split, matcher, runIds) {
  const h = createHash("sha256").update(runIds.join(",")).digest("hex").slice(0, 8);
  return `band-${harness}-${split}-${matcher}-${h}`;
}

// rows: headline rows (each with `repeat` and `write_path` added by the
// driver). meta: section 6 fields except run_id, plus monitor_version and any
// extra labels (stage, audit_rules). Returns { bands, writePaths }.
export function aggregate(rows, { meta, scenarioCount, dropped = [] } = {}) {
  const drop = new Set(dropped);
  const groups = new Map();
  for (const r of rows) {
    if (r.table !== "headline") continue;
    const k = key(r.harness, r.cli_version, r.split, r.matcher);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const bands = [];
  const writePaths = [];
  for (const g of groups.values()) {
    const { harness, cli_version, split, matcher, monitor_version } = g[0];
    const kept = g.filter((r) => !drop.has(r.run_id));
    const repeats = [...new Set(kept.map((r) => r.repeat))].sort((a, b) => a - b);
    const num = [];
    const den = [];
    const rates = [];
    for (const k of repeats) {
      const rs = kept.filter((r) => r.repeat === k);
      const n = rs.reduce((s, r) => s + r.numerator, 0);
      const d = rs.reduce((s, r) => s + r.denominator, 0);
      num.push(n);
      den.push(d);
      rates.push(rate(n, d));
    }
    const runs = kept.map((r) => r.run_id).sort();
    const common = { ...meta, harness, cli_version, monitor_version, split, scenario_count: scenarioCount };
    let b = null;
    try {
      b = band(rates);
    } catch {
      b = null; // every repeat had nothing to capture: no band, never 100%
    }
    bands.push(
      makeRow("headline_band", {
        ...common,
        run_id: bandId(harness, split, matcher, runs),
        matcher,
        repeats,
        runs,
        dropped_runs: g.filter((r) => drop.has(r.run_id)).map((r) => r.run_id).sort(),
        numerator: num,
        denominator: den,
        band: b,
      }),
    );
    for (const wp of [...new Set(kept.map((r) => r.write_path))].sort()) {
      for (const k of repeats) {
        const all = kept.filter((r) => r.repeat === k && r.write_path === wp);
        // contracts/eval.md: a scenario with an unsupported step (no native
        // edit tool) is not in that harness's row; it is listed instead.
        const rs = all.filter((r) => !r.unsupported_step);
        const n = rs.reduce((s, r) => s + r.numerator, 0);
        const d = rs.reduce((s, r) => s + r.denominator, 0);
        writePaths.push(
          makeRow("write_path", {
            ...common,
            run_id: `${bandId(harness, split, matcher, runs)}-${wp}-${k}`,
            scenario_count: new Set(rs.map((r) => r.scenario)).size,
            matcher,
            repeat: k,
            write_path: wp,
            unsupported_scenarios: all.filter((r) => r.unsupported_step).map((r) => r.scenario).sort(),
            numerator: n,
            denominator: d,
            rate: rate(n, d),
          }),
        );
      }
    }
  }
  return { bands, writePaths };
}
