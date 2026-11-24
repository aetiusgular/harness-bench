# Review: P3b, round 1

PR #7, head `5c512ba476a3fcdb9c37a248011c7c1cd04e5ad3`. Reviewed 2026-11-24 by a fresh forge-review session that did not see the build.

Read: BUILD_OUTLINE.md sections 2 to 6 and the P3 checklist (section 5), `briefs/HB.md`, `SPEC.md`, `DECISIONS.md`, `.forge/state.json`, `contracts/truth.md`, `contracts/run.md`, `contracts/api.md` (lane P3b), `scripts/lane-ownership.json`, and every file in `git diff origin/main...HEAD` (7 paths). CI on the head: `ci` run 45444917222 pass, `guard` run 45444917362 pass, `forge/guard` success ("no grader or workflow files touched"), `forge/eval` success ("not an eval phase").

Re-run locally on the head:

- `bash scripts/test.sh`: 57 tests, 41 pass, 0 fail, 16 skipped. The 16 skipped are `tests/model/live.test.mjs`, which needs `HB_CLI_PREFIX`.
- `FORGE_BASE=origin/main bash scripts/forge-gate.sh P3b`: all 17 P3b red tests are "green" and every P3c red test "fails for its stated reason". Result: `forge-gate: P3b passed`.
- `git diff --stat origin/main...HEAD -- tests/red contracts fixtures scripts .github`: empty.
- Attribution scan of the PR body and `git log origin/main..HEAD`: no hits. No key-shaped strings in the diff.
- I wrote a scratch probe (not committed) to test two corner cases against `collectWrites` and `collectConnects`. Results are in C1 and E1 below.

## Checklist (section 5, P3)

| Item | Result |
|---|---|
| Tests were not weakened to pass (diff the test files) | Yes. Nothing under `tests/red/` changed. `tests/truth/collect.test.mjs` is new and only adds tests. |
| No contract edits | Yes. `contracts/` is untouched. The two places where the lane reads the contract its own way are logged in DECISIONS.md and raised under Requests for integration: grouping by the whole `<time>:<serial>` stamp, and each syscall's own dirfd argument. |
| The lane's README section says what ran | Yes. README.md "Lane P3b" gives the commands, the machine and what the tests cover. It says the rule file has not been loaded on a kernel. It has no numbers that would need a results row. The local audit-log format check gives counts only in prose ("every line", "every `SYSCALL` record"), and nothing from that log is committed. |
| Lane-scope clean | Yes (forge-gate output above). |
| Naming and standing constraints | Generic names only. No company names in code. |

Code read against `contracts/truth.md`:
- The write table, flags masks and nametype choice match the contract.
- Normalization, `in_workspace`, the exclusion order (monitor, model server, startup) and the connect family and class rules (including `-115`) match the contract.
- The dirfd argument indexes are right for each syscall: `renameat`/`renameat2`/`linkat` new dirfd `a2`, `symlinkat` `a1`, `openat`/`unlinkat` `a0`.

## Verdict: PASS

There is no S, C or E finding above minor, and no D finding about a number. The three findings below are minor and go to P4.

## Findings

### HB-P3b-r1-C1 (correctness, minor): events are walked in serial order, so the restart case the stamp grouping was added for still breaks the tree

- **Evidence:**
  - `src/truth/parse.mjs:143` sorts by `a.serial - b.serial || a.ts - b.ts`, and `src/truth/collect.mjs:68-84` builds the process tree in that order.
  - DECISIONS.md (P3b, grouping row) says serials can repeat within one log, and that is why it groups by `<time>:<serial>`. If serials do repeat, though, a serial-first sort puts a later event with a low serial ahead of an earlier event with a high serial.
  - Probe: a clone at `audit(1000.000:9)` returns pid 200, and pid 200 writes `/etc/x` at `audit(2000.000:5)`. `collectWrites` returned `[]`. The child's write is dropped because it is processed before the clone that puts it in the tree.
- **Why minor:** the serial is a kernel counter, so it repeats only across a boot (see D1). A run's `[start, end]` window cannot span a boot, so no frozen scenario or box run hits this.
- **Fix (P4):** either sort by `ts`, then serial, for the tree walk and keep serial order for output, or state in DECISIONS.md that repeated serials inside one window are out of scope. The contract says "serial order" for output, so that part needs no change.

### HB-P3b-r1-D1 (docs, minor): the DECISIONS.md reason says auditd restarts reset the serial

- **Evidence:**
  - DECISIONS.md, P3b row 2 says: "Serials restart when auditd restarts or the machine boots".
  - The serial in `msg=audit(<t>:<serial>)` comes from the kernel's own counter (`audit_serial()` in the kernel's `kernel/audit.c`, a static atomic that is incremented for each event). The userspace daemon does not own it, so restarting auditd does not reset it. Only a boot does.
  - The PR body repeats the claim: "a log that spans an auditd restart".
- **Fix:** change the reason to "the serial restarts when the machine boots". The behaviour does not need to change.

### HB-P3b-r1-E1 (eval validity, minor, contract): a connect to `0.0.0.0` or `::` is classed `egress`

- **Evidence:**
  - `src/truth/collect.mjs:203-206` follows `contracts/truth.md` (Connect records): loopback is only `127.0.0.0/8` and `::1`, plus mapped `::ffff:127.x`.
  - Probe: an AF_INET `SOCKADDR` `02001F90000000000000000000000000` (`0.0.0.0:8080`) came back `["0.0.0.0", "egress"]`.
  - On Linux, a connect to the unspecified address reaches the local host. A harness or test script that dials the model server or the monitor's collector as `0.0.0.0` would therefore add an `egress` row that has no host for the monitor to name.
- **Why minor:** the lane does what the contract says, and the frozen scenarios use `127.0.0.1`. The rule only affects secondary table 3, not the headline.
- **Fix (P4, contract change):** class `0.0.0.0` and `::` (and `::ffff:0.0.0.0`) as `loopback` in `contracts/truth.md`, then in `isLoopback`. Add a connect fixture for each.

## Notes for P4 (not findings)

- The two Requests for integration in the PR body are reasonable. They cover recording `O_DIRECTORY` opens so dirfd-relative names can be resolved, and per-syscall dirfd wording in the contract. P4 decides them.
- `pickItem`'s fallback, the last non-`PARENT` item, gives the right name for a denied `rename` onto an existing target. The kernel's `may_delete` logs the target as `DELETE` before the permission check fails. It would be worth adding a fixture event once the box has a real denied `mv` onto `/etc/hosts`.
