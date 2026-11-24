# harness-bench

What agent CLIs actually write, read and send, measured against kernel-level ground truth.

Built in phases with the forge method. Phase P1 (research and the pick) is in `research/P1.md` and `SPEC.md`.

## Lane P3a: scripted model server and harness adapters

`src/model/server.mjs` is a keyless model server on 127.0.0.1. It speaks the four wire formats in `models.lock` (Anthropic Messages, OpenAI Responses, OpenAI chat, Gemini), each through derm's fake server imported from `derm-workspace`. A front server records every request and answers unknown routes with a 404. A request that offers tools is a turn and gets the scenario's next step as a tool call. The tool is chosen from the tools that request offers (`src/model/tools.mjs`). A request with no tools is a side request and does not move the script. `src/harness/adapters.mjs` builds each CLI's argv, an environment that starts empty, and its config files. The model URL comes from the scripted server, and the only credential is `hb-dummy-not-a-key`.

What ran (2026-11-24, AMD Ryzen 5 9600X, Linux, node v24.22.1, CLIs at their `models.lock` versions, installed from npm into a scratch folder):

- `bash scripts/test.sh`: the contract tests and `tests/model/*.test.mjs` pass. The live tests skip without `HB_CLI_PREFIX`.
- `scripts/forge-gate.sh P3a`: every P3a red test is green, and the P3b and P3c red tests still fail for their stated reason.
- `HB_CLI_PREFIX=<folder> node --test --test-concurrency=1 tests/model/live.test.mjs` runs each pinned CLI against this server, with its adapter, on the dev scenarios `plain-shell`, `dotfile-edit` and `dotfile-program` and the calibration `noop`. It checks the scenario's expected file, not auditd. Every case passed:

| Harness | plain-shell | dotfile-edit | dotfile-program | noop |
|---|---|---|---|---|
| claude-code | written | written | written | no tool call |
| codex | written | unsupported (no native write-file tool), not written | written | no tool call |
| gemini-cli | written | written | written | no tool call |
| opencode | written | written | written | no tool call |

These are plumbing checks with no results row behind them (`results/` belongs to no lane). P4 turns them into one (Request for integration in the P3a PR). Gemini CLI writes outside its workspace only for folders passed with `--include-directories`, so the adapter passes the run home and `R/out` (DECISIONS.md, P3a).

The staged upstream patch is in `upstream/beacon-sandbox-scripted-model/`. It applies with `git am` at the monitor's commit `ab6ca05`, and `go vet ./...` and `go test -count=1 ./...` in `beacon-sandbox/` pass there (go1.27.3, this machine). It has not been sent. `NOTES.md` says what it does not cover.

## Lane P3b: ground-truth collector

`src/truth/` reads the kernel's record of a run (`contracts/truth.md`). `renderRules` fills the run user's uid into `contracts/audit.rules.template` and refuses root. `parseAuditLog` groups auditd's RAW or ENRICHED records into events and decodes hex-encoded names, cwd, exe and EXECVE arguments, including long arguments split into chunks. `collectWrites` follows the harness's process tree in time order, through clone records and reparenting to pid 1. It keeps the write syscalls from the contract's table, resolves relative names against the cwd when the name's own dirfd argument is `AT_FDCWD`, and sorts each record into its class (`headline`, `other_syscall`, `openat2_unclassified`, `denied`, `unresolved`) and its exclusion (monitor, model server, startup). `collectConnects` decodes AF_INET and AF_INET6 `SOCKADDR` (RFC 5952 text for v6) and classes each connect as `egress`, `loopback` or `failed`.

What ran (2026-11-24, AMD Ryzen 5 9600X, Linux 7.0.0-43-generic, node v24.22.1):

- `bash scripts/test.sh`: the contract tests, `tests/model/*.test.mjs` and `tests/truth/collect.test.mjs` pass. The truth tests cover corners the fixtures do not: a `node=` prefix, hex cwd and exe, chunked EXECVE arguments, the new-name dirfd of `renameat2` and `symlinkat`, a sign-extended `AT_FDCWD`, the inclusive time window, startup folder and file entries, and RFC 5952 edge cases.
- `scripts/forge-gate.sh P3b`: the P3a and P3b red tests are green, and the P3c red tests still fail for their stated reason.
- The parser was also run over this machine's own `/var/log/audit/audit.log` as a format check, printing counts only. Every line was read as a record, and every `SYSCALL` record had a pid. Some `unlinkat` calls (Python's tree removal, and one harness's own process) used a real directory fd, so they came back `unresolved` (Request for integration in the P3b PR). No rows from that log are kept anywhere.

The rule file has still not been loaded on a kernel (`contracts/truth.md`, Unverified until the box).

## Lane P3c: monitor reader, matcher and scorer

`src/score/` reads the monitor's record of a run and joins it with the kernel's (`contracts/monitor.md`, `contracts/results.md`). `parseMonitorLog` reads the runtime JSONL log, counts lines that are not JSON objects in `bad_lines`, orders events by timestamp and then sequence (not by line), and collects the paths each event names: `file.path`, `tool.path`, the listed keys of a JSON `tool.command`, `parsed_commands` file writes, and the paths in a command line. `commandPaths` splits a command line into shell words (quotes, backslash escapes, redirections attached or separate, `2>&1` not taken as a file) and normalizes `~`, relative paths, `.` and `..`. `matchWrites` runs the contract matcher (E1) or the naive one (E0, `file.path` as written). Each distinct path goes into one column: excluded, another class, in-workspace, or the headline denominator. Paths match only when they are equal, so a path that merely starts with the written one does not count. `matchEgress` counts distinct endpoints per class and matches IP literals from `server.address`, URLs and `host:port` words, comparing IPv6 in RFC 5952 form. Hostnames are listed beside the row, never matched. `rate`, `band`, `makeRow` and `ruleCell` do what `contracts/results.md` and the rule-matrix table say. None of this code has read a real monitor log yet. The fixtures are hand-written in the published shape.

What ran (2026-11-24, AMD Ryzen 5 9600X, Linux 7.0.0-43-generic, node v24.22.1):

- `bash scripts/test.sh`: the contract, model, truth and score tests pass. The live CLI tests skip without `HB_CLI_PREFIX`. `tests/score/score.test.mjs` covers corners the fixtures do not: `2>`, `&>`, `2>>`, `>|`, `2>&1` and `>&2`, pipes and `;`, backslash and double-quote escapes, `~user` and `$VAR` left as written, `..` past the root, the workspace fallback for a missing working directory, timestamps with mixed fraction digits and offsets, column order for excluded records of other classes, IPv6 canonical form and mapped addresses, and every `makeRow` table with each of its fields removed in turn.
- `scripts/forge-gate.sh P3c`: every P3a, P3b and P3c red test is green.

## P4: integration

P4 applied or refused each Request for integration from the P2 to P3c PRs, fixed the review findings that were routed to P4, added the runner, and added cross-lane tests (DECISIONS.md, P4; SECURITY.md, P4 security review).

- **Headline write list.** `open`, `renameat`, `linkat` and `symlinkat` now count as headline writes (SPEC.md, `contracts/truth.md`). On this machine, coreutils `mv` onto an existing file calls `renameat`, and `ln` calls `linkat`.
- **Runner.** `src/run/runner.mjs` refuses euid 0 before it touches the disk. It lays out `R`, runs the scenario's setup inside `R`, spawns the harness through its adapter against the scripted server, records the audit window, writes `R/run.json` and, given the host audit log, writes `R/audit.log`. `scoreRun` turns a finished run into headline, egress and rule-matrix rows.
- **Cross-lane tests** (`tests/integration/`). The collector's output on the fixture logs feeds the matcher and gives the monitor fixtures' numbers. The runner, scripted server and claude-code adapter run all 12 dev scenarios with a stand-in CLI. There are also tests for the root guard, the setup path guard and every contract change.

What ran (2026-11-24, AMD Ryzen 5 9600X, Linux 7.0.0-43-generic, node v24.22.1):

- `bash scripts/test.sh`: passes. The live CLI tests skip without `HB_CLI_PREFIX`.
- `scripts/forge-gate.sh P4`: every red test is green and `tests/integration/` is present.
- `HB_CLI_PREFIX=<scratch> node --test --test-concurrency=1 tests/model/live.test.mjs`: 16 of 16 pass. Every case now also has to exit 0 and reach the server.
- `node scripts/p4-live-runner.mjs <scratch>`: the four pinned CLIs, run through the runner on dev `plain-shell`, `dotfile-edit` and `dotfile-program` and the `noop` calibration. That gives 16 `smoke` rows in `results/p4-live-runner.jsonl`, all with `keyless_write: true`. Codex's `dotfile-edit` row has `unsupported_step: true`, because Codex offers no native write-file tool. These runs had no monitor and no auditd, and their network was not restricted (SECURITY.md T-5).
