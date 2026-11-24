# Results rows

Every row in `results/*.jsonl` is one JSON object with the BUILD_OUTLINE.md section 6 fields, plus `table` and the fields of its table. `scripts/forge-gate.sh` checks the section 6 fields from P5 on; `makeRow` (lane P3c, `api.md`) refuses a row without them.

## Section 6 fields (every row)

| Field | Type | Value here |
|---|---|---|
| `run_id` | string | `run.md`, Run id. A band row uses `band-<harness>-<split>-<matcher>-<8 hex>`. |
| `git_sha` | string | `git rev-parse HEAD` at run time |
| `machine` | string | read at run time from `/proc/cpuinfo` (`model name`), `/proc/meminfo` (`MemTotal`) and `nvidia-smi` if present; on the box, `$FORGE_MACHINE_FILE` |
| `model_revision` | string | the split's `split-sha256` (the model is the scripted server; `models.lock`) |
| `quant` | null | no quantized model |
| `runtime` | string | `node <version>` |
| `date` | string | ISO 8601, UTC |

## Common fields

`table`, `harness`, `cli_version`, `monitor_version`, `split`, `scenario_count`.

## Tables

| `table` | One row per | Extra fields |
|---|---|---|
| `headline` | run, matcher | `scenario`, `matcher` (`contract` or `naive`), `numerator`, `denominator`, `rate`, `excluded` (`{monitor, model_server, startup}`), `other` (`{other_syscall, openat2_unclassified, denied, unresolved}`), `in_workspace`, `missed` (paths) |
| `headline_band` | harness, split, matcher | `matcher`, `runs` (run ids), `numerator`, `denominator` (sums over the split, per repeat), `band` (`{min, median, max, n}` over the repeats' rates) |
| `write_path` | harness, split, matcher, write path, repeat | `write_path`, `numerator`, `denominator`, `rate` |
| `rule_matrix` | harness, rule, scenario, run | `rule_id`, `scenario`, `cell` (`monitor.md`, Rule-matrix cell) |
| `egress` | run | `connects`, `named`, `missed` (endpoints), `loopback`, `failed`, `excluded` (`{monitor, model_server}`), `hostnames` (hosts the monitor names that the kernel record cannot show), all from `matchEgress` (`monitor.md`, The egress join), and `boundary` |
| `startup` | path | `path` (`run.md`, Startup exclusions) |
| `smoke` | harness | `keyless_write` (bool), `requests` (model requests seen) |

## Rates

`rate` is `numerator / denominator`, a number in `[0, 1]`, or `null` when the denominator is 0. It is never `NaN` and a run with nothing to capture is never reported as 100%.

## Band

`band(rates)` over one harness's five repeats: `min`, `max`, `median` (the middle value; for an even count, the mean of the two middle values) and `n`. `null` rates are left out and `n` counts only the rest. An empty input (or all `null`) is an error: `band: no rates`.

## Never

No composite across harnesses. No row is edited after it is written; a rerun appends rows with a new `run_id`.
