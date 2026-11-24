# contracts/

Written in P2. The seams the lanes build against. Lanes do not edit this folder; changes go under "Requests for integration" in the PR and P4 applies them.

| File | What it fixes | Lanes that read it |
|---|---|---|
| `api.md` | Module paths, function signatures and error messages of every seam | all |
| `run.md` | The layout of one run on disk, the run user, the path variables and the run id | all |
| `scenario.md` | The scenario file format and its neutral actions | P3a, P3c |
| `truth.md` | The ground-truth write and connect records the collector emits, and how each auditd record is classified | P3b, P3c |
| `audit.rules.template` | The exact auditd rule set (Tony installs it on the box) | P3b |
| `monitor.md` | How the monitor's runtime log and its scan findings are read, what counts as an event naming a path, and the egress join | P3c |
| `results.md` | The `results/*.jsonl` row for each table | P3c |
| `eval.md` | The frozen split, E0 and E1, five-run bands | all |

`eval.md` freezes the split (BUILD_OUTLINE.md section 6). `scripts/forge-gate.sh` reads two lines from it:

```
split-sha256: <64 hex characters>
split-path: <file or folder in the repo>
```

A file hashes as its sha256. A folder hashes as the sha256 of the `sha256sum` lines of its files, sorted by path, paths relative to the folder:

```
(cd <folder> && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) | sha256sum
```

Leave out `split-path` only when the split cannot live in the repo (data terms); the gate then checks that the hash is present but cannot recompute it.
