# Security

Open items, rendered into the README in P6. Severity: high, medium, low.

| ID | Severity | Item | Owner | Workaround | Status |
|---|---|---|---|---|---|
| T-1 | low | `ci` runs the PR's own copy of `ci.yml`, so a PR that edits it could post statuses with the workflow token. | Tony | `forge/guard` (base copy) fails any PR that touches `.github/`, and review reads the diff. | open |
| T-2 | low | gitleaks honours inline `gitleaks:allow` comments; a PR could mark a line as allowed. | Tony | Review greps the diff for `gitleaks:allow`. | open |
| T-3 | low | Under the box's `landlock` profile, TCP rules name ports, not addresses: the model port and the proxy (ephemeral) port range are open to any host, not only 127.0.0.1. | Tony | Only for projects with `eval_boundary: landlock`; the box's nftables rules and the proxies' own allowlists still apply. | open |
| T-4 | low | A harness whose base URL is not set falls back to its vendor's API and sends the dummy credential and the scenario prompt there. It happened once in P2 while the smoke script was being written (one request to the vendor's API with the token `hb-dummy-not-a-key`, refused with 401). | P3a | Every adapter sets the base URL from the scripted server (red test P3a-adapter-points-at-server). In the P3a live check every run of every pinned CLI reached the scripted server (`tests/model/live.test.mjs`). That shows the base URL was used. It does not show that nothing else left the machine, so box runs still limit the network to 127.0.0.1 (scripts/eval.sh, P4 and P5). | open |
| T-5 | low | Live checks off the box (`tests/model/live.test.mjs`, `scripts/p4-live-runner.mjs`) run the pinned CLIs with approvals off and with this machine's normal network. Nothing limits a CLI's own traffic there, and nothing measured it. | P5 | The adapters set each CLI's base URL, a dummy credential, and telemetry and update switches off. Every P4 live run reached the scripted server (`results/p4-live-runner.jsonl`). Measured runs happen only on the box, under `srt` or landlock with the network limited to 127.0.0.1 (BUILD_OUTLINE.md section 8). | open |
| T-6 | low | `R/audit.log` holds every record the rules keep for the run account inside the run window, including that account's other processes, not only the harness's tree. | P5 | Written mode 0600 inside `R`, never copied into `results/`, and `removeRun` deletes `R`. Rows hold counts and paths of the harness's tree only. | open |
| T-7 | low | `startServer({ host })` with a host other than 127.0.0.1 exposes the scripted server, and its request log, to that network. | P5 | The runner always uses the default 127.0.0.1. The inner derm fake listens on 127.0.0.1 only. | open |

## P4 security review (2026-11-24)

Scope: every input, file write, subprocess call and network call in `src/`, and everything that runs another tool. Findings that need a change are T-5 to T-7 above; none is above low.

| Area | Where | What was checked | Result |
|---|---|---|---|
| Inputs: scenario files | `src/run/runner.mjs` `prepareRun`, `src/model/vars.mjs` | Setup paths are resolved after variable substitution and must lie inside `R`; `${WS}/../../x` is refused before any write (`tests/integration/runner.test.mjs`). Unknown variables throw. The scenario id must match `[a-z0-9-]+` before it becomes part of a folder name. | ok |
| Inputs: monitor log, findings | `src/score/monitor.mjs` | `JSON.parse` only, no evaluation. A bad line is counted, not fatal. Shell words are tokenized, never run. Nested shells recurse at most four levels. | ok |
| Inputs: audit log | `src/truth/parse.mjs`, `collect.mjs` | Regex and hex decoding only. Hex arguments go through `BigInt` after a `[0-9A-Fa-f]+` check. | ok |
| File writes | `runner.mjs`, `src/harness/adapters.mjs` | Writes go to `R` (setup, adapter config files, `run.json`, `audit.log` at 0600) and to `results/` (append only). `adapterFor().command` refuses a config file outside home and workspace. `removeRun` deletes only a folder whose name starts with `hb-`. | ok |
| Subprocess calls | `runner.mjs` `spawnHarness`, `src/run/meta.mjs` | `spawn` and `execFileSync` with argv arrays, no shell. The harness env is built from nothing except `PATH` (`api.md`). Each run has a timeout and is killed with SIGKILL when it passes it. | ok |
| Root | `assertNotRoot` | Runs first in `prepareRun` and `runOnce`. With `geteuid` stubbed to 0, both throw and the temp folder stays empty (HB-P2-r2-S1 closed). `renderRules` refuses uid 0. The `hosts-edit` run leaves `/etc/hosts` unchanged (kernel refusal, non-root). | ok |
| Network | `src/model/server.mjs` | Listens on `host`, by default 127.0.0.1. A failed `listen` now closes the inner fake (HB-P3a-r1-C2). No call leaves the machine from this build's code; derm is a pinned git dependency installed with `--ignore-scripts`. | ok, T-7 |
| Tools run by this build | the pinned CLIs | They run with approvals off as the run account, HOME in `R/home`. What they do is fixed by the frozen scenarios: writes under `R` and the `/etc/hosts` attempt. Their own network is T-4 and T-5. | ok, T-4, T-5 |
| Secrets | whole repo | The only credential is `hb-dummy-not-a-key`. The scenario `authkeys` line is `hb-fixture-not-a-key`. No key is read from the environment. | ok |
