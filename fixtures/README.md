# fixtures/

Written in P2. Small, committed inputs the red tests and lanes run against. Public data only; record where each fixture came from and its licence. No customer data, no scraped marketplace data, no keys.

Everything here was written by hand in P2 (2026-11-24) for this repo and is under the repo's MIT licence. Nothing was captured from a real monitor, a real harness's prompts, or a real audit log of any machine.

| Path | What | Source |
|---|---|---|
| `scenarios/dev/`, `scenarios/heldout/` | The frozen split, 24 `hb-scenario/1` files (`contracts/scenario.md`). Hashed in `contracts/eval.md`. | Hand-written. Targets follow the monitor's published `sensitive-edit` rules (`research/P1.md` section 1); the paths are run-local (`contracts/run.md`). The `authorized_keys` line is the literal text `hb-fixture-not-a-key`, not a key. |
| `calibration/noop.json` | The no-op scenario that measures startup writes. Outside the split, hashed on its own. | Hand-written |
| `audit/basic.log`, `basic.context.json`, `basic.expected.json` | A synthetic auditd log of one run (29 events), its run context, and the records the collector must return. Each event is one corner case in `tests/red/truth.test.mjs`. | Hand-written in auditd's RAW record format (`type=... msg=audit(<time>:<serial>): key=value ...`, as documented in `auditd.conf(5)` and `ausearch(8)`). pids, inodes and times are made up. |
| `audit/enriched.log`, `enriched.expected.json` | One event in auditd's ENRICHED format (interpreted fields after a `0x1d` byte). | Hand-written |
| `monitor/basic.runtime.jsonl`, `basic.expected.json` | A synthetic runtime log of the same run (10 events and one broken line) in the monitor's published JSONL schema, and the parse and match results it must give. | Hand-written from the monitor's docs (`docs/telemetry-schema/event-schema.mdx`, `fields.mdx`, `examples.mdx` at the commit in `models.lock`; MIT) |
| `monitor/basic.scan.json` | A findings array in the shape of the monitor's `scan --json` output. | Hand-written from the monitor's `Finding` struct (`pkg/asymptoteobserve/threatrules/findings.go` at the same commit) |
| `model/*.json` | Minimal request bodies for the four wire formats: a turn per format and one side request. | Hand-written. The tool names (`Bash`, `Write`, `exec_command`, `run_shell_command`, `write_file`, `bash`, `write`) are the ones the pinned CLIs offered in the P2 keyless smoke run; the system prompts and schemas are placeholders, not the harnesses' text. |

`tests/contract/fixtures.test.mjs` recomputes the monitor fixture's expected numbers from the ground-truth fixture, so the two cannot drift apart.
