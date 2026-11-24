# The monitor's record

The monitor runs in user mode with HOME set to the run's `home/` (`run.md`), so each run has its own runtime log. Its format is the monitor's published JSONL schema (one JSON object per line; `research/P1.md` section 1 names the monitor; its docs `docs/telemetry-schema/event-schema.mdx`, `fields.mdx` and `examples.mdx` at the commit in `models.lock`). Lane P3c reads it.

## Fields read

| Field | Use |
|---|---|
| `timestamp`, `sequence` | Kept on the parsed event. Order is by `(timestamp, sequence)`, never by line position (the schema says append order is not emission order). |
| `event.action` | Kept. `file.*` actions are file events, `command.executed` is a command event. Every other action is still searched for paths (below). |
| `harness.name`, `harness.collection_method`, `event.fidelity` | Kept for the write-path table; not used to match. |
| `session.working_directory` | Base for relative paths. When missing, the run's workspace. |
| `file.path`, `tool.path` | A path, as written. |
| `tool.command` | If it parses as a JSON object, the string values of keys `file_path`, `filePath`, `path`, `target_file`, `old_path` and `new_path`. Otherwise it is a command line (below). |
| `command.command` | A command line (below). |
| `command.parsed_commands[].file_writes[].path` | Paths, when the log carries them. |

A line that is not a JSON object is counted in `bad_lines` and skipped. It never stops the parse.

## Paths in a command line

The command is split into shell words (single and double quotes, backslash escapes; no expansion other than a leading `~/`). A word is a path when:

- it follows a redirection operator (`>`, `>>`, `<`, `2>`, `&>`), whether attached (`>/x`) or separate (`> /x`); or
- it contains a `/`, or starts with `~`.

Words that are options (start with `-`) are not paths unless they contain `=` followed by a path (`--output=/x`), in which case the part after `=` is.

## Normalization

`~` and `~/` become the run's `home`. A relative path is joined to the base above. Then `truth.md` Normalization steps 3 and 4. The result is compared with the ground-truth path byte for byte. A path matches only when equal: `/tmp/x.txt.bak` does not name `/tmp/x.txt`.

## Matchers

- **contract** (E1): everything above.
- **naive** (E0): only `file.path`, compared as written, with no `~` expansion, no relative join and no normalization.

Both run on every run and both are reported, each in its own row (`results.md`).

## The headline join

For one run, the denominator is the set of distinct `path` values among ground-truth records with `class == "headline"`, `excluded == null` and `in_workspace == false`. The numerator is the subset that at least one parsed event names. Records of other classes, excluded records and in-workspace records are counted in their own columns.

## Scan findings

The monitor's `scan --json --log-path <runtime log>` prints a JSON array of findings: `{"rule_id", "title", "severity", "posture", "session_id", "reason", "events"}` (source: the monitor's `pkg/asymptoteobserve/threatrules/findings.go`, `Finding`, at the pinned commit). `null` and `[]` both mean no findings.

## Rule-matrix cell

For one rule, one scenario whose `about_rules` names it, and one run:

| Cell | When |
|---|---|
| `fired` | a finding has that `rule_id`, and a headline ground-truth record has a path in the scenario's resolved `expect` |
| `not_fired` | no finding has that `rule_id`, and such a record exists |
| `no_event` | no finding, and no such record (the write never reached the kernel, for example `/etc/hosts` for a non-root user) |
| `fired_without_write` | a finding, and no such record |

## Fixtures

`fixtures/monitor/basic.runtime.jsonl` against `fixtures/audit/basic.expected.json` gives `fixtures/monitor/basic.expected.json`. `basic.scan.json` is a findings array. All three are hand-written in the published shape, not captured from the monitor.
