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
