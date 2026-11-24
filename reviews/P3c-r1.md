# Review: P3c, round 1

PR #8, head `874c47b0a8f786a89070eca3883eb00fdcc8d3ea`. Reviewed 2026-11-24 by a fresh forge-review session that did not see the build.

Read: BUILD_OUTLINE.md sections 2 to 6 and the P3 checklist (section 5), `briefs/HB.md`, `.forge/state.json`, `contracts/monitor.md`, `contracts/results.md`, `contracts/scenario.md`, `contracts/api.md` (lane P3c), `scripts/lane-ownership.json`, and every file in `git diff origin/main...HEAD` (10 paths). CI on the head: `ci` run 45466680480 success, `guard` run 45466680592 success, `forge/guard` success ("no grader or workflow files touched"), `forge/eval` success ("not an eval phase").

Re-run locally on the head (AMD Ryzen 5 9600X, node v24.22.1):

- `bash scripts/test.sh`: 84 tests, 68 pass, 0 fail, 16 skipped. The 16 skipped are the live CLI tests, which need `HB_CLI_PREFIX`.
- `node --test tests/score/score.test.mjs`: 27 tests, 27 pass.
- `FORGE_BASE=origin/main bash scripts/forge-gate.sh P3c`: 59 red tests "green" (21 of them P3c), `lane-scope: lane P3c clean since 3b0a28877d3e (10 path(s))`, `forge-gate: P3c passed`.
- `git diff --stat origin/main...HEAD -- tests/red contracts fixtures`: empty. `git diff origin/main...HEAD -- tests/ | grep -c '^-[^-]'`: 0, so no test line was removed.
- Attribution scan of the PR body and the head commit message: no hits. No key-shaped strings in the diff.
- A scratch probe (not committed) ran `commandPaths`, `parseMonitorLog` and `matchEgress` on corner cases. Its output is quoted in the findings.

## Checklist (section 5, P3)

| Item | Result |
|---|---|
| Tests were not weakened to pass (diff the test files) | Yes. Nothing under `tests/red/` changed. `tests/score/score.test.mjs` is new and only adds tests. |
| No contract edits | Yes. `contracts/` is untouched. The three places where the contract leaves room (column order, the extra redirection operators, timestamp order) are logged in DECISIONS.md. Two contract gaps (common fields on `smoke`/`startup` rows, JSON `tool.command` for egress) and the duplicated normalizer are raised under Requests for integration. |
| The lane's README section says what ran | Yes. README.md "Lane P3c" gives the commands, the machine and what the tests cover. It says no real monitor log has been read and the fixtures are hand-written. It states no numbers that would need a results row. |
| Lane-scope clean | Yes (forge-gate output above). |
| Naming and standing constraints | Generic names only. No company names in code. |

Code read against the contracts:
- `parseMonitorLog`: reads the fields in monitor.md's table (`file.path`, `tool.path`, the six JSON `tool.command` keys, `command.command`, `parsed_commands[].file_writes[].path`), counts non-object lines in `bad_lines`, and orders by `(timestamp, sequence)` as instants. The probe gave `+0100`, a lowercase `t` and mixed fraction digits the right order, with an unparseable timestamp last.
- `matchWrites`: the denominator is distinct `headline`, non-excluded, out-of-workspace paths, and matches are exact. The naive matcher reads only `rawEvents[].file.path` as written.
- `matchEgress`: endpoint format, per-class distinct counts, ports ignored, and hostnames listed but never matched all follow "The egress join".
- `rate`, `band` (nulls dropped, even-count median as a mean), `makeRow` (section 6, common and table fields) and `ruleCell` (the four cells) match results.md and the rule-matrix table.

## Verdict: PASS

There is no S, C or E finding above minor, and no D finding about a number. The four findings below are minor. E1 and E2 need contract changes, so they go to P4 as Requests for integration. C1 and C2 are small lane fixes that P4 can make while it is in these files.

## Findings

### HB-P3c-r1-E1 (eval validity, minor): a write inside a nested shell (`sh -c '...'`, `bash -lc "..."`) is not extracted

- **Evidence:** probe: `commandPaths("sh -c 'echo x > /tmp/z'", {home: "/h", base: "/w"})` returns `["/w/echo x > /tmp/z"]`. The quoted inner command is one word containing `/`, so it becomes one made-up path, and `/tmp/z` is never named. This follows `contracts/monitor.md` ("Paths in a command line" splits once). But a harness or monitor that logs the shell tool's command wrapped as `bash -lc "<cmd>"` would have every shell-path headline write counted as missed by the scorer, not by the monitor. That would understate the contract matcher's rate for that harness.
- **Fix:** Request for integration (contract change, P4): when the first word is `sh`, `bash`, `zsh` or `dash` and an option word contains `c`, split the following argument again as a command line. Until P5 shows how each harness's commands are logged, check the first real runtime log for wrapped commands before reporting the shell-path row.

### HB-P3c-r1-E2 (eval validity, minor): a JSON `tool.command` with a `command` key yields no write paths, not only no egress

- **Evidence:** `src/score/monitor.mjs:4` lists only `file_path`, `filePath`, `path`, `target_file`, `old_path`, `new_path`, and line 66 reads only those keys once `tool.command` parses as a JSON object. Probe: an event with `tool.command = '{"command":"printf x >> /tmp/hb/out/a.txt"}'` and no `command.command` gives `paths: []`. The PR's Request for integration raises this shape only for the egress join ("Egress join reads JSON `tool.command`").
- **Fix:** widen that Request for integration in P4 to the write join: when a JSON `tool.command` has a string `command` (or `cmd`) value, read it as a command line.

### HB-P3c-r1-C1 (correctness, minor): a here-doc or here-string word is taken as a file path

- **Evidence:** `src/score/words.mjs:72` makes no operator out of `<<`, `<<-` or `<<<`, so they tokenize as repeated `<`, and `src/score/monitor.mjs:22` takes the next word as a redirection target. Probe: `commandPaths("cat <<EOF > /tmp/x", {base: "/w"})` gives `["/w/EOF", "/tmp/x"]`. `commandPaths("cat <<<hello; cat <<-EOF", {base: "/w"})` gives `["/w/hello", "/w/-EOF"]`. These are in-workspace paths, so they never enter the headline denominator, and they could match only an in-workspace record named `EOF`. That is why this is minor.
- **Fix:** tokenize `<<`, `<<-` and `<<<` as operators that `isFileRedirect` does not include, and add the two probe cases to `tests/score/score.test.mjs`.

### HB-P3c-r1-C2 (correctness, minor): a URL after `--opt=` is not seen by the egress join

- **Evidence:** `src/score/match.mjs:95` matches a URL only at the start of a word. Probe: `matchEgress` with an egress record for `192.0.2.1:80` and the command `curl --url=http://192.0.2.1/ -o x` reports it in `missed`. Write paths already read the part after `=` of an option ("Paths in a command line"). The egress section says only "split as in Paths in a command line", so the current code follows the contract's wording.
- **Fix:** in P4, apply the same `--opt=<value>` rule to egress words (one line in the `matchEgress` word loop), with a test.
