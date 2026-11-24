# Ground truth: the kernel's record

The collector (lane P3b) reads an auditd log written under `audit.rules.template` and returns one record per write the harness's process tree made. Nothing in this build writes the audit log; the build installs the rules and reads the log (SPEC.md, Ground truth).

## Input

- The text of `/var/log/audit/audit.log` (or a copy), RAW or ENRICHED format. In ENRICHED format a record carries interpreted fields after a `0x1d` byte; the collector reads the raw part and ignores the rest.
- The run's context, `run.md` `run.json`: `run_id`, `root_pid`, `start`, `end`, `workspace`, `home`, `exclude`.

## Grouping

Records belong to one event when they share the serial in `msg=audit(<seconds>.<ms>:<serial>)`. Records of different events can interleave in the file. An event is the `SYSCALL` record plus its `EXECVE`, `CWD`, `PATH` and `PROCTITLE` records; `EOE` ends it but may be missing. Events outside `[start, end]` are dropped (pid reuse).

## Process tree

A pid is in the tree when it is `root_pid`, or a fork/clone/vfork/clone3 event with a pid in the tree returned it (`exit=<child pid>`), or its `SYSCALL` record names a parent (`ppid=`) in the tree. Membership is decided in time order, so a process that was reparented to pid 1 (a daemon) stays in the tree through its clone record.

## Which events are writes

Only events whose syscall is in this table. `a2` is the `openat` flags argument and `a1` the `open` flags argument, both hex.

| Syscall | Write when | Op | Path item | Class |
|---|---|---|---|---|
| `openat` | `a2 & 0x243` is non-zero | `write` | the PATH item with nametype `CREATE` or `NORMAL` (not `PARENT`) | `headline` |
| `openat2` | nametype `CREATE` | `write` | the `CREATE` item | `headline` |
| `openat2` | nametype `NORMAL` (flags not visible to audit) | `write` | the `NORMAL` item | `openat2_unclassified` |
| `creat` | always | `write` | `CREATE` or `NORMAL` item | `headline` |
| `truncate` | always | `truncate` | the `NORMAL` item | `headline` |
| `rename`, `renameat2` | always | `rename` | the `CREATE` item (the new name) | `headline` |
| `unlink`, `unlinkat` | always | `unlink` | the `DELETE` item | `headline` |
| `link`, `symlink` | always | `link`, `symlink` | the `CREATE` item (the new name) | `headline` |
| `open` | `a1 & 0x243` is non-zero | `write` | `CREATE` or `NORMAL` item | `other_syscall` |
| `renameat`, `linkat`, `symlinkat` | always | as their non-`at` forms | as their non-`at` forms | `other_syscall` |

`headline` is exactly SPEC.md's list of writes. `open`, `renameat`, `linkat` and `symlinkat` are writes too, but SPEC.md's list does not name them, so they get their own column until P4 decides the Request for integration in the P2 PR. A read-only `openat` (`a2 & 0x243 == 0`) is not a write and is not returned. Any write event with `success=no` is returned with class `denied`, whatever its syscall.

## Normalization

1. A PATH `name` is either quoted (`name="/tmp/a"`) or, when it holds a space, a quote or a control byte, unquoted hex (`name=2F746D702F612062` is `/tmp/a b`). Hex is decoded to bytes, then read as UTF-8.
2. A relative name is joined to the event's `CWD`. (auditd writes the name as the program passed it. A relative name with a directory fd other than `AT_FDCWD`, `a0=ffffff9c`, cannot be resolved from the log; the record is returned with class `unresolved` and its name as given.)
3. `.` and `..` segments are removed and repeated `/` collapsed. Symlinks are not resolved: the path is as auditd recorded it (SPEC.md: "symlinks resolved as auditd resolves them").
4. A trailing `/` is removed except for `/` itself.

## Output record

One JSON object per write, in serial order:

```json
{"run_id": "r1", "serial": 503, "syscall": "openat", "op": "write", "pid": 4105, "path": "/tmp/hb-r1/home/.bashrc", "in_workspace": false, "class": "headline", "excluded": null}
```

| Field | Meaning |
|---|---|
| `class` | `headline`, `other_syscall`, `openat2_unclassified`, `denied` or `unresolved` |
| `in_workspace` | `run.md`, Workspace |
| `excluded` | `null`, or why the scorer keeps it out of the denominator: `monitor` (the exe starts with an `exclude.monitor_exe_prefixes` entry), `model_server` (pid in `exclude.model_server_pids`), `startup` (path equal to an `exclude.startup_paths` entry, or under one ending in `/`). First match in that order. |

Writes by a pid in `exclude.model_server_pids` are returned even though that pid is not in the harness's tree. Writes by any other pid outside the tree are not returned.

The collector may add fields (for example `exe`, `comm`, `ts`); consumers ignore fields they do not know.

## Fixtures

`fixtures/audit/basic.log` with `basic.context.json` gives `basic.expected.json`; `enriched.log` gives `enriched.expected.json`. Every row of the class table above and every corner case in `tests/red/truth.test.mjs` has an event in `basic.log`.

## Unverified until the box

The rule file has not been loaded on a kernel in P2 (no root in P2). Tony installs it on the box; if `auditctl` rejects a line, that is a Request for integration, not a lane edit.
