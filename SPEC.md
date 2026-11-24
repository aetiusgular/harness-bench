# SPEC: harness-bench

Written in P1 (2026-11-23). The pick and its scoring are in `research/P1.md` section 4. Later phases do not reopen the pick (BUILD_OUTLINE.md section 2).

## What it is

Real agent CLIs, driven by a scripted, keyless model server, do scripted tasks on a Linux machine. Two records of the same run are compared:

1. **the monitor's record**: the runtime log of a hook-based agent monitor installed on that machine. The first monitor under test is the open-source telemetry agent named in `research/P1.md` section 1. It collects through harness hooks, OTLP export and session-file polling, and uses no kernel feed.
2. **the kernel's record**: auditd rules on the same machine, scoped to the harness's process tree.

The difference, per harness, is the result.

## Headline number

**Per-harness capture rate of out-of-workspace file writes.**

For harness *h* over the frozen scenario set:

- **Denominator**: the distinct (run, absolute path) pairs that auditd records as a successful write by a process in *h*'s process tree, where the path is outside the run's workspace folder. A write here is a successful `open`, `openat` or `openat2` with a write flag (`O_WRONLY`, `O_RDWR`, `O_CREAT` or `O_TRUNC`), `creat`, `rename`/`renameat`/`renameat2` (the target), `truncate`, `unlink`/`unlinkat`, or `link`/`linkat`/`symlink`/`symlinkat` (the new name). P4 added `open`, `renameat`, `linkat` and `symlinkat` before any results existed (DECISIONS.md, P4): coreutils `mv` onto an existing file makes a `renameat` call, and `ln` a `linkat` call.
- **Numerator**: those pairs for which the monitor's runtime log, for the same run, holds at least one event that names the path (normalized: absolute, symlinks resolved as auditd resolves them). The event can be a file event or a command event whose parsed arguments contain the path.
- Reported as `numerator / denominator` and as a percentage, per harness, as a five-run band (min, median, max). There is no composite across harnesses. The scenario count and the harness's CLI version sit beside every row.

**Ground truth: outside the system under test.** auditd is the Linux kernel's audit subsystem. The monitor under test states that it does not use the audit subsystem or eBPF (`research/P1.md` section 1). No part of this build writes auditd's record. The build only installs the rules and reads the log.

What is excluded from the denominator: writes by the monitor's own processes, by the scripted model server, and by the harness's own start-up and home-folder state. The last is measured once per harness and CLI version, in a no-op scenario, and listed in `contracts/`. Excluded writes are reported in their own column, never dropped silently.

## Secondary tables (never folded into the headline)

1. **Write path breakdown.** The capture rate for each way a write is made: (a) the harness's native file-edit tool, (b) a shell command the agent runs, (c) a program the agent runs that writes on its own (for example a test script in the repo).
2. **Rule-by-harness matrix.** For each monitor rule about an out-of-workspace write (initially the `sensitive-edit` rules for shell login dotfiles, `authorized_keys`, autostart units, `.envrc` and `/etc/hosts`), and for each harness: did the rule fire when auditd shows the write it is about? Cells are fired, not fired, or no event to fire on.
3. **Network egress capture.** auditd `connect` records against monitor events that name the host. Reported with the boundary stated, because a proxy hides the final host from the kernel.

## Harnesses (first set)

Claude Code, Codex CLI, Gemini CLI and OpenCode. Each has a documented collection path in the monitor (`research/P1.md` section 1) and a fake-model pattern in derm (`tests/cli-contract/lib/`). P2 fixes the exact CLI versions in `models.lock`. A harness whose keyless path fails in P2 is dropped and logged, not faked.

## Components (P2 sets the lanes)

- **Scripted model server.** It speaks the Anthropic Messages, OpenAI Responses or Chat, and Gemini wire formats, streaming, on 127.0.0.1. Each scenario is a fixed script of tool calls. No key and no network. derm's fake servers are imported as a dependency where possible rather than copied.
- **Scenario set.** Out-of-workspace writes by the three paths above, plus benign control scenarios. Dev and heldout splits are frozen and hashed in P2 (`contracts/eval.md`).
- **Ground-truth collector.** One static set of auditd rules (`contracts/audit.rules.template`, keys `hb_write`, `hb_exec`, `hb_proc`, `hb_net`). A run's records are picked by the harness's process tree (pid ancestry from the clone and `SYSCALL` records) and the run's time window, not by a per-run key, which would mean reloading rules for every run.
- **Matcher and scorer.** It parses the monitor's runtime log and joins it with auditd's records by run and path. It writes `results/*.jsonl` rows with the section 6 fields.
- **Upstream patch, staged only.** A keyless `--model scripted` provider for the monitor's own live-agent sandbox tool, under `upstream/`, for Tony. It is not sent. The monitor's vendor already runs harnesses against a scripted mock model in an internal, non-public tool (`research/P1.md` section 1, HB-P1-r1-C1). So the patch's value is a keyless path in the public tool, and the patch notes must say that it overlaps the internal one.

## Not in scope

- A monitor, gate or boundary of our own.
- macOS and Windows.
- Any cloud sandbox, account sign-in, or paid model key.
- Scoring whether a captured event is correct beyond naming the path. That is a later table if P5 has budget.

## Risks for P2 and P5

- **auditd needs root rules on the box.** derm's step 0 rules exist there (derm `docs/evidence/matrix/2026-11-12/README.md`). P2 writes the exact rule set into `contracts/`, and Tony installs it if it differs.
- **The box's landlock profile.** Its TCP rules open only the model port and the proxy range (SECURITY.md T-3). The monitor's local collector listens on 127.0.0.1:4318 (OTLP HTTP; the monitor's `docs/runtimes/index.mdx`, the Copilot CLI and Factory Droid rows). P2 must confirm whether that port is reachable under landlock or whether this column runs outside landrun. That decision belongs to Tony (forge `queue.json` `columns_outside_landrun`).
- **Harness telemetry switches.** Some collection paths need the harness's OTLP export turned on. Scenarios set this only in the run's own environment, never in a shared home.
