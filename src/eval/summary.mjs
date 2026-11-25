// results/summary.md from one eval invocation (scripts/eval.sh posts it as
// the PR comment). Every number here is a sum or a copy of fields in the rows
// the same invocation appended to results/*.jsonl. Tables are per harness;
// there is no composite (BUILD_OUTLINE.md section 6 item 6).

const pct = (x) => (x === null || x === undefined ? "n/a" : `${(100 * x).toFixed(1)}%`);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function bandLine(b) {
  if (!b.band) return `no band (denominator 0 in every repeat) | ${b.numerator.join(", ")} / ${b.denominator.join(", ")}`;
  return `${pct(b.band.min)} / ${pct(b.band.median)} / ${pct(b.band.max)} (n=${b.band.n}) | ${b.numerator.join(", ")} / ${b.denominator.join(", ")}`;
}

export function summarize(report) {
  const out = [];
  out.push(report.pilot ? "# P5 pilot (not the measured run)" : "# P5 eval");
  out.push("");
  out.push(`Rows: \`${report.out}\`. Monitor ${report.monitorVersion}. Audit rules: \`${report.auditRules}\`. Boundary: \`${report.boundary}\`.`);
  if (report.pilot) out.push("", "The audit rules on this machine are not `contracts/audit.rules.template`, so these rows are a pilot of the pipeline. No number here is the headline.");
  if (report.calibration) {
    out.push("", "## Calibration (startup exclusions)", "", "| Harness | Excluded paths | Refused |", "|---|---|---|");
    for (const c of report.calibration) out.push(`| ${c.harness} | ${c.paths.map((p) => `\`${p}\``).join("<br>") || "none"} | ${c.refused.map((r) => `\`${r.path}\` (${r.reason})`).join("<br>") || "none"} |`);
  }
  for (const s of report.stages) {
    out.push("", `## ${s.stage} (${s.split}, ${s.rows.filter((r) => r.table === "headline" && r.matcher === "contract").length} runs)`);
    if (s.dropped.length) out.push("", `Dropped runs (timed out, or audit window split by two rotations): ${s.dropped.map((x) => `\`${x}\``).join(", ")}`);
    out.push("", "### Headline: out-of-workspace write capture, per harness", "", "| Harness | CLI | Matcher | Band min / median / max | Numerators / denominators per repeat |", "|---|---|---|---|---|");
    for (const b of s.bands) out.push(`| ${b.harness} | ${b.cli_version} | ${b.matcher} | ${bandLine(b)} |`);
    out.push("", "### Write path (contract matcher, summed over repeats)", "", "| Harness | Write path | Captured / written | Unsupported scenarios |", "|---|---|---|---|");
    for (const h of [...new Set(s.writePaths.map((w) => w.harness))]) {
      for (const wp of [...new Set(s.writePaths.filter((w) => w.harness === h).map((w) => w.write_path))]) {
        const ws = s.writePaths.filter((w) => w.harness === h && w.write_path === wp && w.matcher === "contract");
        const un = [...new Set(ws.flatMap((w) => w.unsupported_scenarios))];
        out.push(`| ${h} | ${wp} | ${sum(ws.map((w) => w.numerator))} / ${sum(ws.map((w) => w.denominator))} | ${un.join(", ") || "none"} |`);
      }
    }
    const heads = s.rows.filter((r) => r.table === "headline" && r.matcher === "contract");
    out.push("", "### Side columns (contract matcher, summed over runs)", "", "| Harness | excluded monitor / model server / startup | denied | unresolved | other_syscall | openat2_unclassified |", "|---|---|---|---|---|---|");
    for (const h of [...new Set(heads.map((r) => r.harness))]) {
      const rs = heads.filter((r) => r.harness === h);
      const e = (k) => sum(rs.map((r) => r.excluded[k]));
      const x = (k) => sum(rs.map((r) => r.other[k]));
      out.push(`| ${h} | ${e("monitor")} / ${e("model_server")} / ${e("startup")} | ${x("denied")} | ${x("unresolved")} | ${x("other_syscall")} | ${x("openat2_unclassified")} |`);
    }
    const cells = s.rows.filter((r) => r.table === "rule_matrix");
    out.push("", "### Rule-by-harness matrix (cell counts over runs)", "", "| Harness | Rule | fired | not_fired | no_event | fired_without_write |", "|---|---|---|---|---|---|");
    for (const h of [...new Set(cells.map((r) => r.harness))]) {
      for (const rule of [...new Set(cells.filter((r) => r.harness === h).map((r) => r.rule_id))].sort()) {
        const cs = cells.filter((r) => r.harness === h && r.rule_id === rule);
        const n = (c) => cs.filter((r) => r.cell === c).length;
        out.push(`| ${h} | ${rule} | ${n("fired")} | ${n("not_fired")} | ${n("no_event")} | ${n("fired_without_write")} |`);
      }
    }
    const eg = s.rows.filter((r) => r.table === "egress");
    out.push("", `### Egress (boundary \`${report.boundary}\`, summed over runs)`, "", "| Harness | connects | named | loopback | failed | hostnames named only by name |", "|---|---|---|---|---|---|");
    for (const h of [...new Set(eg.map((r) => r.harness))]) {
      const rs = eg.filter((r) => r.harness === h);
      out.push(`| ${h} | ${sum(rs.map((r) => r.connects))} | ${sum(rs.map((r) => r.named))} | ${sum(rs.map((r) => r.loopback))} | ${sum(rs.map((r) => r.failed))} | ${[...new Set(rs.flatMap((r) => r.hostnames))].join(", ") || "none"} |`);
    }
  }
  out.push("");
  return out.join("\n");
}
