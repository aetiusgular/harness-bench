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
| `tool.command` | If it parses as a JSON object, the string values of keys `file_path`, `filePath`, `path`, `target_file`, `old_path` and `new_path` are paths, and the value of `command` or `cmd` is a command line (a string as it is; an array of strings as the argv it runs). Otherwise it is a command line (below). |
| `command.command` | A command line (below). |
| `command.parsed_commands[].file_writes[].path` | Paths, when the log carries them. |

A line that is not a JSON object is counted in `bad_lines` and skipped. It never stops the parse.

## Paths in a command line

The command is split into shell words (single and double quotes, backslash escapes; no expansion other than a leading `~/`). Unquoted `|`, `;`, `&`, `&&` and `||` end a command. A word is a path when:

- it follows a file redirection operator (`>`, `>>`, `<`, `2>`, `&>`, `2>>`, `&>>`, `>|`), whether attached (`>/x`) or separate (`> /x`); or
- it contains a `/`, or starts with `~`.

The word after any other redirection operator is not a word of the command: a descriptor (`>&2`, `2>&1`), a here-doc delimiter (`<<EOF`, `<<-EOF`) or a here-string (`<<<text`). The lines of a here-doc body (after the end of the line that holds `<<`, up to the delimiter line) are data, not words.

A shell run as `sh`, `bash`, `zsh`, `dash` or `ksh` (by name or path) at the start of a command, with an option word that holds `c` (`-c`, `-lc`, `-ec`), runs its next word as a command line. That word is split again by these rules, up to four levels deep, instead of being read as one word.

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

## The egress join

For one run, `matchEgress(connectRecords, rawEvents)` reads the collector's connect records and the parsed JSON lines of the runtime log.

- An **endpoint** is `<address>:<port>` for `inet` and `[<address>]:<port>` for `inet6`.
- `connects` is the number of distinct endpoints among records with `class == "egress"` and `excluded == null`. `loopback` and `failed` are the same count for those classes. `excluded` counts distinct endpoints per reason, whatever their class.
- The **words** of an event are the words of `command.command` and of `tool.command`, split as in Paths in a command line (nested shells included). When `tool.command` parses as a JSON object, its words are its string values (one level into arrays and objects, for a native fetch tool's `{"url": ...}`) plus the words of its `command` or `cmd` command line. For an option word `--opt=<value>`, the value is the word.
- An event **names an address** when its `server.address` equals it, or when one of its words is a URL whose host is that address (`scheme://<address>[:port]/...`, with `[...]` around an IPv6 address), is `<address>:<port>`, or is exactly the address (an IP literal, as in `nc 192.0.2.10 443`). The port is not compared: the monitor does not always record it.
- `named` is the number of `connects` endpoints whose address at least one event names. `matched` and `missed` list them.
- `hostnames` are the distinct hosts in `server.address` or in such URLs that are not IP literals. The kernel record holds addresses only, and this build keeps no DNS log, so a hostname is never matched to an address. It is reported beside the row, not dropped. Matching hostnames would need a resolver record. P4 did not add one (DECISIONS.md, P4): auditd does not see DNS answers, and a resolver log of our own would be a second ground truth written by this build. `hostnames` stays a listed column.

The `boundary` field of the row is the run's boundary as P5 sets it. Under a proxy most connects are `loopback`, because the kernel sees the proxy, not the final host (SPEC.md, secondary table 3). The table is never folded into the headline.

## Fixtures

`fixtures/monitor/basic.runtime.jsonl` against `fixtures/audit/basic.expected.json` gives `fixtures/monitor/basic.expected.json`. `basic.scan.json` is a findings array. `connect.runtime.jsonl` against `fixtures/audit/connect.expected.json` gives `connect.expected.json`. All are hand-written in the published shape, not captured from the monitor.
