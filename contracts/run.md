# One run on disk

A run is one harness doing one scenario once. The runner (P4) lays it out like this before the harness starts:

```
$HB_TMP/hb-<run_id>/          R, the run root (HB_TMP defaults to /tmp)
  ws/                         the workspace: the harness's cwd
  home/                       HOME for the harness, the monitor's user-mode install and its runtime log
  out/                        a folder outside the workspace that scenarios write into
```

## Path variables

Scenario files, fixtures and startup-exclusion lists use these, and only these:

| Variable | Value |
|---|---|
| `${WS}` | `R/ws` |
| `${HOME}` | `R/home` |
| `${OUT}` | `R/out` |

All three are absolute and contain no symlink (the runner calls `realpath` on R). A string with `${` and any other name is an error: `unknown variable ${NAME}`. There is no escape syntax; no scenario needs a literal `${`.

## Run user

The harness, the monitor and every program a scenario runs execute as one ordinary account, never uid 0. The runner (P4) refuses to start when its effective uid is 0, before it does any setup, and `renderRules` refuses `uid: 0` (`api.md`). Three frozen scenarios (`hosts-edit`, `hosts-program`, `hosts-shell`) try to write `/etc/hosts`; for this account the kernel refuses the write, and the collector puts it in the `denied` column (`truth.md`). Run as root, they would change the machine's real `/etc/hosts`.

## Run id

`<harness>-<scenario id>-<repeat 1..5>-<8 lowercase hex>`, for example `codex-dotfile-edit-3-9f2c01ab`. It is unique per run and goes into every results row.

## Workspace

A path is inside the workspace when it equals `R/ws` or starts with `R/ws/`. `R/ws-evil/x` is outside. Comparison is on the normalized absolute path (`truth.md`, Normalization), byte for byte.

## What the runner records per run

`R/run.json`, written by the runner, read by the collector and the scorer:

```json
{
  "run_id": "codex-dotfile-edit-3-9f2c01ab",
  "harness": "codex",
  "cli_version": "0.172.0",
  "scenario": "dotfile-edit",
  "split": "dev",
  "root_pid": 4100,
  "start": 1764000000.0,
  "end": 1764000100.0,
  "workspace": "/tmp/hb-codex-dotfile-edit-3-9f2c01ab/ws",
  "home": "/tmp/hb-codex-dotfile-edit-3-9f2c01ab/home",
  "exclude": {
    "monitor_exe_prefixes": ["/tmp/hb-codex-dotfile-edit-3-9f2c01ab/home/.beacon/"],
    "model_server_pids": [3000],
    "startup_paths": ["/tmp/hb-codex-dotfile-edit-3-9f2c01ab/home/.codex/"]
  }
}
```

`root_pid` and `exclude.model_server_pids` are pids as auditd logs them, in the initial pid namespace. The runner first writes the pids it sees. When it reads the audit log, it takes the first successful `execve`/`execveat` in the slice (the window and its one-second margin, because the kernel's coarse audit clock can stamp the root's execve a few ms before `start`) whose CWD is the harness's cwd and whose argv holds the harness's argv[0]. That record's `pid` becomes `root_pid` and its `ppid` the server pid, and run.json is rewritten. `runOnce` returns `rootPidFrom`, and P5 copies it into each run row as `root_pid_from`: `child` (no audit log read), `audit` (same pid as the runner saw), `audit_translated` (another pid: the runner is in a pid namespace, as in the srt column under bwrap `--unshare-pid`), or `unanchored` (no such record: the runner's pids are kept and P5 drops the run from bands). See HB-P5-r2-E1.

`start` and `end` are the audit clock (seconds since the epoch, as in `msg=audit(<seconds>.<ms>:<serial>)`) taken just before the harness is spawned and just after it exits. `fixtures/audit/basic.context.json` is the same shape with the fields the collector reads.

## Audit log

The kernel writes `/var/log/audit/audit.log` (or `$HB_AUDIT_LOG`) as auditd configures it. The runner runs as the run account (Run user), never as root, and never calls `sudo`, so it reads the log through auditd's `log_group`: on the box, `log_group` in `/etc/audit/auditd.conf` is a group the run account belongs to (Tony sets it with the rules; P5 checks it before E1). When the log is unreadable, `readAuditLog` stops with an error that names `log_group`. After a run, the runner writes the lines whose `msg=audit(<t>:` stamp falls in `[start - 1, end + 1]` to `R/audit.log`; the collector reads that file and applies the exact window itself. A rotated log that splits the window is P5's to check.

## Startup exclusions

Each harness and CLI version runs `fixtures/calibration/noop.json` (no tool calls) five times. Every out-of-workspace path it writes in any of the five runs is a startup path for that harness and version. A path ending in `/` excludes everything under it. P5 writes the measured lists to `results/startup-<harness>-<version>.jsonl` (one row per path, table `startup`), and the runner reads them from there. Excluded writes are counted in their own column and never dropped silently (SPEC.md, Headline number).

How P5 writes the list (`src/eval/startup.mjs`, DECISIONS.md P5). Start-up writes carry run-varying names (temp files with a pid and random suffix, a project folder named after the run root, sqlite journals), so an exact path from one calibration run would exclude nothing in the next. Each path is written with the variables above and replaced by its parent folder (`.../`). A file directly in `${HOME}`, `${OUT}` or a one-component folder outside R (`/tmp`, `/etc`) stays an exact path. A folder not seen in all five runs is widened to its parent until it is, never to `${HOME}/` or a one-component folder. An entry that would cover any scenario's `expect` or `expect_denied` path, or the folder that holds R, is refused, listed in `results/summary.md`, and not written.
