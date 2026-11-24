// results/*.jsonl rows with the section 6 fields (contracts/results.md).

const SECTION6 = ["run_id", "git_sha", "machine", "model_revision", "quant", "runtime", "date"];
const COMMON = ["harness", "cli_version", "monitor_version", "split", "scenario_count"];
const TABLES = {
  headline: ["scenario", "matcher", "numerator", "denominator", "rate", "excluded", "other", "in_workspace", "missed"],
  headline_band: ["matcher", "runs", "numerator", "denominator", "band"],
  write_path: ["write_path", "numerator", "denominator", "rate"],
  rule_matrix: ["rule_id", "scenario", "cell"],
  egress: ["connects", "named", "missed", "loopback", "failed", "excluded", "hostnames", "boundary"],
  startup: ["path"],
  smoke: ["keyless_write", "requests"],
};
const CELLS = new Set(["fired", "not_fired", "no_event", "fired_without_write"]);

export function makeRow(table, fields) {
  if (!(table in TABLES)) throw new Error(`unknown table: ${table}`);
  const f = fields ?? {};
  for (const name of [...SECTION6, ...COMMON, ...TABLES[table]]) {
    if (!Object.hasOwn(f, name) || f[name] === undefined) throw new Error(`missing field: ${name}`);
  }
  if (f.quant !== null) throw new Error("bad field: quant must be null (no quantized model)");
  if ("rate" in f && f.rate !== null && !(typeof f.rate === "number" && f.rate >= 0 && f.rate <= 1)) {
    throw new Error(`bad field: rate ${f.rate} is not null or in [0, 1]`);
  }
  if (table === "rule_matrix" && !CELLS.has(f.cell)) throw new Error(`bad field: cell ${f.cell}`);
  if ((table === "headline" || table === "headline_band") && f.matcher !== "contract" && f.matcher !== "naive") {
    throw new Error(`bad field: matcher ${f.matcher}`);
  }
  const { table: _ignored, ...rest } = f;
  void _ignored;
  return structuredClone({ table, ...rest });
}
