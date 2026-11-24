# beacon-sandbox: keyless `--model scripted` (staged patch)

**Status: staged only, not sent.** Nobody has pushed, opened a PR, filed an issue or commented anywhere. Whether this goes upstream, and in what form, is the maintainer's (Tony's) call.

- Patch: `0001-beacon-sandbox-scripted-model.patch` (`git format-patch`, one commit, author `harness-bench <noreply@invalid>`)
- Target: the public `agent-beacon` repository, module `beacon-sandbox/`, base commit `ab6ca05cd65d7b076caa1d28963cab42a5057001`
- Size: 14 files changed, 1365 insertions, 6 deletions. About half of that is tests: 665 lines across five test files, four of them new.

## Overlap with the vendor's internal tool (read this first)

The vendor already runs harnesses against a scripted mock model, in an internal tool called **beacon-oracle** that is not public. The repository says so itself:

- `cli/beacon-hooks/testdata/claude/README.md:3-6` (at ab6ca05): the fixtures were captured from a session that "ran in beacon-oracle's sealed container against its scripted mock model and fixture MCP server".
- PR #754 (commit `e7e40e8f`, body lines 63-65): "I ran real Claude Code 2.1.291 in a disposable Linux container against a local mock model".
- PR #753 (commit `9ba8d443`, body lines 72-74): the same kind of live check for Oh My Pi, "against a local mock model".
- PR #1241 (commit `e545c824`, body line 88): "beacon-oracle replay of recorded Codex 0.167.0 runs".

So this patch covers ground the vendor's internal tool already covers. What it adds is a keyless path in the **public** tool. Today anyone outside the vendor who runs `beacon-sandbox` needs a paid Anthropic key. With this patch they can run a scripted scenario with no key and no model traffic.

## What the patch does

Current behaviour at ab6ca05:

- `run` needs an Anthropic key. The README says so (`beacon-sandbox/README.md:19`: "an Anthropic API key with credit, since the test runs a real agent session"; `:24`). `credentials.Resolve` returns an error when no key is found (`beacon-sandbox/credentials/credentials.go:124-146`). `cmdRun` calls it for every provider except github (`beacon-sandbox/cmd/beacon-sandbox/main.go:148`). `runner.Run` refuses `SourceNone` (`beacon-sandbox/runner/runner.go:82-84`).
- Blocking egress is only useful without a model call (`beacon-sandbox/scenario/scenario.go:175-176`). Otherwise the launch allow-lists the Anthropic domains (`beacon-sandbox/runner/runner.go:165-170`).

The patch adds:

1. **The `scriptedmodel` package (new).** A loopback stand-in for the Anthropic Messages API, served on `127.0.0.1` at a free port. It handles three kinds of request:
   - A `POST /v1/messages` that offers tools is a "turn". It gets the next script step as a `tool_use` block (stop reason `tool_use`). Once the steps run out it gets the final text with `end_turn`.
   - A `POST /v1/messages` that offers no tools is a "side" request (title, summary or quota probe). It gets a short text and does not advance the script.
   - `POST /v1/messages/count_tokens` gets a fixed count and does not advance the script.

   Replies stream as Messages-API SSE (`message_start`, then a start/delta/stop triple per block, `message_delta`, `message_stop`), or come back as plain JSON when `stream` is false. Tool input travels as `input_json_delta`. A step whose tool the request does not offer ends the session. The reply names the missing tool, and the exchange is recorded as `unsupported`. Any other route gets a 404 and is recorded.
2. **`script:` in scenario YAML (new, optional).** It is a list of `{tool, input}` steps, and `{{canary}}`, `{{sentinel}}` and `{{workdir}}` are expanded at any depth (`scenario.ExpandInput`). `Validate` rejects:
   - a step with no tool
   - a tool name with surrounding whitespace
   - a tool that `tools:` does not allow
   - a tool that `disallowed_tools:` removes

   `Suite.Scripted()` selects the scenarios that have a script. `s02-bash-command` and `s03-file-write` gain scripts that do exactly what their prompts ask, and a test pins that.
3. **`run --model anthropic|scripted`.** The default is `anthropic`, and nothing changes when the flag is unset: the session script is byte-for-byte the same, which a test checks. With `scripted`:
   - No credential is resolved. The new `credentials.SourceScripted` makes the leak-check warning say "the run used the scripted model, so no credential was supplied".
   - `--modal-secret` or `--api-key-command` alongside the flag is refused.
   - Scenarios without a script are not run, and the count is reported. Naming one with `--scenario` is an error.
   - The session command gets `ANTHROPIC_BASE_URL=<stand-in>`, a placeholder `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and blank `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`. The blanking matters on the local provider, because the guest inherits this process's environment (`beacon-sandbox/sandbox/localexec.go:233`), so a real key in a CI job would otherwise be sent to the stand-in.
   - The launch asks for `BlockEgress` with no allow-list.
   - Each run writes `scripted-model.json` (every request and how it was answered) and records `model`, `scripted_steps_sent` (for example `1/1`), `scripted_requests` and, when relevant, `scripted_stopped` in `meta.json`.
   - Offline `verify` of a scripted run does not search for an ambient key.
4. **README.** A short "Without an API key" section and a layout line.

## Where the scripted server runs, per provider

| Provider | In this patch | Why |
|---|---|---|
| `local` | **Supported.** The stand-in runs inside the `beacon-sandbox` process on 127.0.0.1. | The local guest is this machine (`beacon-sandbox/sandbox/localexec.go:143`, `MutatesHost` returns true), so the agent can reach this process's loopback. |
| `modal` | **Refused** with an error naming `--provider local` (in `main.checkModel`, and again in `runner.checkScripted`). | A Modal guest is another machine, so 127.0.0.1 there is not this process. |
| `github` | **Refused** the same way. | The Windows run executes inside a dispatched workflow (`--provider local` on the runner). Supporting it needs a workflow input that selects the model, which is outside this module. |

### What Modal would need (not done)

It is feasible. The runner already ships binaries into the guest: `ImageSpec.Files` (`beacon-sandbox/sandbox/provider.go:50`) is uploaded by `Modal.EnsureImage` (`beacon-sandbox/sandbox/modal.go:104`), and that is how the Beacon build gets in (`beacon-sandbox/image/image.go:321`). `PostPushLayers` then makes the binaries executable (`beacon-sandbox/image/image.go:402`). Loopback works even under `BlockEgress` (`beacon-sandbox/sandbox/provider.go:73`, `beacon-sandbox/sandbox/modal.go:161`).

The same `scriptedmodel` handler could sit behind a tiny `main`, built as a static `GOOS=linux GOARCH=amd64 CGO_ENABLED=0` binary and added to `Files`. The runner would then:

- write the expanded script into the guest
- start the binary as the agent user with `nohup`
- read the port it chose from a file
- pass that URL into the session environment
- copy the transcript back with `Get`

There is a precedent for exactly this shape: the forwarding probe already runs a stand-in HTTP server on the guest's loopback and reads its port back (`beacon-sandbox/runner/forward.go:43`, `:109`). That one is in Python, which the image installs (`beacon-sandbox/image/image.go:265`).

I left this out for three reasons:

- I could not run it here (no Modal account in this session).
- It needs a build step inside `run`.
- The nested-systemd lane needs the env forwarded with `docker exec -e` (`beacon-sandbox/runner/guest.go:155-159`).

It is the obvious next patch if the maintainer wants this.

## How to apply

```bash
git checkout ab6ca05cd65d7b076caa1d28963cab42a5057001   # or a branch at that commit
git am /path/to/0001-beacon-sandbox-scripted-model.patch
cd beacon-sandbox && go build ./... && go test ./...
```

I checked this here: `git am` applied cleanly to a fresh worktree at ab6ca05, and the resulting tree is identical to the commit the patch was made from.

Usage, on a disposable machine (the local provider refuses to start elsewhere unless given `--allow-host-mutation`, `beacon-sandbox/sandbox/localexec.go:98-114`):

```bash
go run ./cmd/beacon-sandbox run --provider local --model scripted --scenario s02-bash-command
```

## What ran, and where

Everything ran on this Linux machine (linux/amd64) with `go version go1.27.3 linux/amd64` (`/usr/local/go/bin/go`). Module dependencies were downloaded from the default `GOPROXY`, and nothing else was fetched.

**Baseline, at ab6ca05, before any change** (`go build ./...` then `go test ./...` in `beacon-sandbox/`): the build passed and every package passed: check, cmd/beacon-sandbox, credentials, dispatch, hostguard, image, runner, sandbox, scenario.

**With the patch** (in `beacon-sandbox/`, and again in the fresh `git am` worktree):

| Command | Result |
|---|---|
| `gofmt -l .` | no output (clean) |
| `go vet ./...` | clean |
| `go build ./...` | pass |
| `go test -count=1 ./...` | all 10 packages `ok`: check, cmd/beacon-sandbox, credentials, dispatch, hostguard, image, runner, sandbox, scenario, scriptedmodel |

One test was skipped: `runner.TestGeneratedPowerShellParses`. This is not caused by the patch; the test skips when `pwsh` is not installed, and it is not installed here. No test needed Modal, GitHub or the network.

The `FAIL s01-hello` lines that appear in `go test -v` output are verdict text the existing `check` tests print on purpose, not test failures.

New tests, all passing:

- `scriptedmodel`:
  - turns advance through the script and end with `end_turn`
  - side requests do not advance
  - `count_tokens` does not advance
  - an unoffered tool ends the session
  - the SSE event sequence and `input_json_delta` are correct
  - unknown routes get a 404
  - the server listens on loopback
- `scenario`:
  - YAML decoding, including nested input
  - an unknown step field is rejected
  - each rejection rule above
  - tool rules like `Bash(echo:*)` are accepted
  - `Suite.Scripted`
  - deep expansion without mutating the scenario
  - the shipped scripts match their prompts
- `runner`:
  - `ParseModel`
  - `checkScripted`
  - unchanged script without the mode
  - env assignments land on `beacon ci exec` and reach the child, with a real key in the parent blanked (run through a real `sh`)
  - the PowerShell form
  - expansion and transcript/meta recording
- `credentials`: the scripted source's wording.
- `cmd/beacon-sandbox`:
  - the default model on every provider
  - scripted needs local
  - a credential flag is refused
  - an unknown model is refused
  - `scriptedSuite`
  - offline verify of a scripted run

**Live check against real Claude Code.** This used the Claude Code installed on this machine, **2.1.330**, not the image's pinned 2.1.220 (`beacon-sandbox/image/image.go:32`). It ran with an isolated `HOME`, no real credential, and the stand-in on loopback. Throwaway harness code was used and is not in the patch.

1. The stand-in served a two-step script (Bash, then Write) to `claude -p ... --output-format json --dangerously-skip-permissions --max-budget-usd 1.00`, with no `--model` flag. Result: `is_error=false`, `subtype=success`, `num_turns=3`, result `scripted run complete`. Both files were written with the canary, and the transcript showed `turn` step 0 Bash, `turn` step 1 Write, then a final `turn` with text.
2. The same run with OTLP/HTTP exported to a local sink: `/v1/logs` (carrying the user prompt and tool result) and `/v1/metrics` both arrived with and without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. So that switch does not suppress the telemetry Beacon reads. Without it, Claude Code also sent `HEAD /api/hello` to the stand-in; with it, it did not.
3. The patch's own generated session script (`withSessionEnv(posixShell, scriptedSessionEnv(url), CIExecSession(...))`) ran under `bash` for the real `s02-bash-command` and `s03-file-write` scenarios.
   - `beacon` was a shim that only executes the command after `--`, and the parent environment held a fake `ANTHROPIC_API_KEY`.
   - Both sessions succeeded (`CI_EXEC_RC=0`, `is_error=false`) and wrote the sentinel with the canary. Each run's `scripted_steps_sent` was `1/1`.
   - The child saw `ANTHROPIC_API_KEY` empty.

**Not run:**

- A full `beacon-sandbox run --provider local --model scripted`. That installs Beacon and rewrites agent settings on the machine it runs on, which this workstation is not for. So the real `beacon ci exec` collector, Beacon's capture, and the verdict on a scripted run are **unverified**.
- No Modal or GitHub run of any kind.

## What it does not cover

- **modal and github providers**, and the nested-systemd lane. See above. They are refused with an explicit error, not silently degraded.
- **`doctor`** knows nothing about `--model scripted`. It still reports `anthropic_credential` as it does today.
- **The argv credential check reports unverified on scripted runs.** The sampler is keyed on `ANTHROPIC_API_KEY` (`beacon-sandbox/runner/shell.go:152`, `:358`, `:387`), which a scripted run does not have. That is the honest outcome, because there is no secret to leak, but it is a WARN and not a pass. The artifact leak check likewise WARNs that it cannot run.
- **Egress is not enforced on the local provider.** The patch asks for `BlockEgress`, but `LocalExec` does not apply launch-time network policy. "No model call leaves the machine" holds because the agent's API base points at loopback and non-essential traffic is off, not because a firewall enforces it.
- **Step counting is stateful and sequential.** Every turn request advances the script, so a client retry of a turn, or a subagent's own turn, would consume a step. Side detection is "offers no tools", the same rule as the reference fake servers.
- **Usage is fixed** (100 input and 10 output tokens per reply). Token and cost expectations pass on scripted runs, but the numbers are synthetic.
- **Only two scenarios have scripts** (s02, s03). The others, including the install scenarios, would need their own. s07 cannot be scripted as written: its `disallowed_tools: ["Bash"]` removes the tool, and the new validation rejects a script that calls it.
- **Model fidelity.** A scripted run checks Beacon's capture of real Claude Code tool execution and telemetry. It does not check anything that depends on a real model's behaviour, such as prompt variance or the model choosing tools.
