# Review: P3a, round 1

PR #6, head `69d91720aaebea09b8ec784a830f553fc7911b30`. Reviewed 2026-11-24 by a fresh forge-review session that did not see the build.

Read: BUILD_OUTLINE.md sections 2 to 6 and the P3 checklist (section 5), `briefs/HB.md`, `SPEC.md`, `DECISIONS.md`, `.forge/state.json`, `contracts/api.md`, `contracts/scenario.md`, `scripts/lane-ownership.json`, every file in `git diff origin/main...HEAD` (15 paths), and the CI on the head: `ci` run 45424787005 success, `guard` run 45424787009 success, `forge/guard` success ("no grader or workflow files touched"), `forge/eval` success ("not an eval phase").

Environment note: `git -C forge pull` failed with "Cannot rebase onto multiple branches". The review used forge at `f0b013b`. The outline sections used here are the ones in that copy.

Re-run locally on the head:

- `bash scripts/test.sh`: 46 tests, 30 pass, 0 fail, 16 skipped. The 16 skipped are `tests/model/live.test.mjs`, which needs `HB_CLI_PREFIX`.
- `FORGE_BASE=origin/main bash scripts/forge-gate.sh P3a`: all 20 P3a red tests are "green". Every P3b and P3c red test "fails for its stated reason". Lane-scope: "lane P3a clean since e384beab8956 (15 path(s))". Split hash matches. Result: `forge-gate: P3a passed`.
- `git diff --stat origin/main...HEAD -- tests/red contracts fixtures scripts .github`: empty. No red test, contract, fixture, script or workflow is touched.
- Attribution scan of `git log origin/main..HEAD` (`Co-Authored-By`, `claude`, `anthropic`, `Generated with`): no hits. The diff contains no `gitleaks:allow` (SECURITY.md T-2). The only key-shaped string is `sk-ant-ambient`. It is a test fixture in the staged patch's `model_test.go` and is not a key.
- Upstream patch, checked independently. I took a fresh shallow fetch of the public monitor repository at `ab6ca05cd65d7b076caa1d28963cab42a5057001`. `git am 0001-beacon-sandbox-scripted-model.patch` printed "applied". In `beacon-sandbox/`, `gofmt -l .` gave no output and `go vet ./...` was clean. `go test -count=1 ./...` gave `ok` for all 10 packages: check, cmd/beacon-sandbox, credentials, dispatch, hostguard, image, runner, sandbox, scenario and scriptedmodel. I used go1.27.3 on linux/amd64. Nothing was pushed or sent anywhere.
- `fixtures/scenarios/{dev,heldout}`: all 24 scenarios have exactly one step. That supports DECISIONS.md P3a ("No frozen scenario has more than one step").

## Earlier findings carried into this lane

| ID | Status | Evidence |
|---|---|---|
| HB-P2-r1-C2 (no red test for the upstream patch) | Fixed | The patch adds Go tests for `scriptedmodel`, `scenario`, `runner`, `credentials` and `cmd/beacon-sandbox`. They pass after a clean `git am` at `ab6ca05` (above). NOTES.md says what was not run: a full `beacon-sandbox run`, and the Modal and GitHub providers. |

## Checklist (section 5, P3)

| Item | Result |
|---|---|
| Tests were not weakened to pass (diff the test files) | Yes. Nothing under `tests/red/` changed, and `tests/red/manifest.json` is untouched. The new files are `tests/model/*.test.mjs` and `tests/model/lib.mjs`. They only add tests. |
| No contract edits | Yes. `contracts/` is untouched. The signatures of `startServer` and `adapterFor` match `contracts/api.md`. The three points where the lane's reading of the contract may differ (the `/v1/models` 200, Gemini's `R/out` derived from `dirname(workspace)`, and the `/etc/hosts` cells) are raised under Requests for integration, not edited. |
| The lane's README section says what ran | Yes. README.md "Lane P3a" names the commands, the machine, the CLI versions and the live cases. It says the table has no results row behind it and that P4 will add one. The table holds no numbers. |
| Lane-scope clean | Yes (forge-gate output above). |
| Naming and standing constraints | The repo, package and flag names are generic: `scriptedmodel` and `--model scripted`. Company names appear only in README, NOTES and research prose. The patch was not sent. Its author is `harness-bench <noreply@invalid>`. |

## Verdict: PASS

There is no S, C or E finding above minor, and no D finding about a number. The two new findings below are minor. They go to P4. Neither one changes what the lane measures.

## Findings

### HB-P3a-r1-C1 (correctness, minor): the live `noop` case passes when the CLI never runs

- **Evidence:**
  - `tests/model/live.test.mjs:81-82` skips the "a turn reached the server" check when `id === "noop"`.
  - `fixtures/calibration/noop.json` has `"expect": []`, so `assert.deepEqual(r.written, [])` is always true.
  - The test never reads `r.status` (lines 61-64 store it, and lines 77-83 do not assert on it).
  - So a CLI that exits 1 at start-up, or never contacts the server, passes `live <h> noop`.
  - README.md's table still reports "no tool call" for `noop` on all four harnesses.
- **Why it matters:** `noop` is the calibration run that measures each harness's start-up writes for the exclusion column (SPEC.md "What is excluded"). A noop run that died early would under-measure them.
- **Fix:** in the noop branch, assert `r.status === 0` and `r.turns >= 1`, or at least one request of kind `turn` or `side`. Better still, assert exit status 0 for every live case. This applies when P4 builds the runner on the adapters and turns the live check into a results row.

### HB-P3a-r1-C2 (correctness, minor): a failed `listen` leaks derm's inner fake server

- **Evidence:**
  - `src/model/server.mjs:149` starts the fake before `front.listen` (lines 176-179).
  - If `listen` rejects, the fake is never closed.
  - Probe (scratch script, not committed): start one server, then start a second on the same `port`. The second rejected with `EADDRINUSE`. Active handles went from 2 to 4 and stayed at 4 after the first server's `close()`. The process did not exit by itself.
- **Why it matters:** with the default `port = 0` this needs an unusual failure. But a P4 runner that retries on a fixed port would pile up loopback listeners nobody records. Those listeners would also show up in the model-server exclusion.
- **Fix:** wrap the listen in `try { ... } catch (e) { await fake.close(); throw e; }`. Add a test in `tests/model/server.test.mjs` that a rejected start leaves no extra handles.

## Notes for P4 and P5 (not findings)

- The Gemini adapter's `--include-directories <R/home>,<R/out>` changes what counts as Gemini's own workspace (DECISIONS.md, P3a). P5 should check whether the monitor classifies writes to those folders differently for Gemini than for the other three harnesses. If it does, report it next to the Gemini rows. This is already partly raised under Requests for integration (the `/etc/hosts` cells).
- On a `host` other than 127.0.0.1, the inner fake still listens on 127.0.0.1 at an unrecorded port (`server.mjs:117`). That is within "listens on `host` only" for the front server. The inner port should be named in the model-server exclusion when P4 attributes auditd records.
