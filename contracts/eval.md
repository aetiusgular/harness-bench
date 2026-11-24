# Eval plan (BUILD_OUTLINE.md section 6)

Frozen in P2 on 2026-11-24. The split below does not change after P2. A change is a new split with a new hash, recorded in DECISIONS.md as Tony's call, and every number from the old split stays labeled with the old hash.

split-sha256: cea71bd723d3df3593da84f364109d71b66d5b1401da14f9848472a65ad58e10
split-path: fixtures/scenarios

The hash covers both splits (`fixtures/scenarios/dev/` and `fixtures/scenarios/heldout/`), computed as `contracts/README.md` says. The calibration scenario is outside the split and hashed on its own:

calibration-sha256: eaaefd03478fd67b4831a7ceaa36ff8329454afc3aba452ca921a18103149e00  fixtures/calibration/noop.json

## The split

| Split | Scenarios |
|---|---|
| dev (12) | `authkeys-shell`, `autostart-edit`, `autostart-program`, `control-edit`, `dotfile-edit`, `dotfile-program`, `envrc-shell`, `hosts-edit`, `hosts-program`, `plain-shell`, `rename-shell`, `unlink-program` |
| heldout (12) | `authkeys-edit`, `authkeys-program`, `autostart-shell`, `control-shell`, `dotfile-shell`, `envrc-edit`, `envrc-program`, `hosts-shell`, `plain-edit`, `plain-program`, `rename-program`, `unlink-shell` |

The assignment rule is in `contracts/scenario.md`, The frozen set. The scenarios were written before any harness ran against them, from the monitor's published `sensitive-edit` rule targets (`research/P1.md` section 1) and SPEC.md's three write paths.

## What is tuned, and on what

The system under test (the monitor) is not tuned. What can be tuned is this build's own matcher, the part that decides whether a monitor event names a path (`contracts/monitor.md`). It is tuned on dev only. Heldout runs once per release, after the matcher is frozen for that release, and its rows are labeled `split: heldout`.

## E0: blind baseline

Before any matcher change past the contract, P5 runs every harness on dev with the **naive** matcher (`contracts/monitor.md`, Matchers: `file.path` compared as written) and records it. The naive rows are kept beside the contract rows in every later run, so the effect of the matcher is visible.

## E1: the measured run

| Run | Split | Matcher | Repeats |
|---|---|---|---|
| E1-dev | dev | contract and naive | 5 per harness |
| E1-heldout | heldout | contract and naive | 5 per harness, once per release |
| calibration | `noop` | none (startup paths only) | 5 per harness and CLI version, before E1 |

## Five-run bands

No LLM is in the loop: the model is the scripted server, and its replies are a fixed function of the scenario. The harnesses still vary run to run (timers, hook timing, export intervals, process scheduling), so every headline number is a five-run band (`contracts/results.md`, Band). `models.lock` pins the CLI versions, the monitor release and the derm commit; `model_revision` in each row is this split's hash.

## Judges

None. Matching is deterministic string equality after normalization. There is no LLM judge, so section 6 item 5 does not apply.

## Ground truth

auditd on the box under `contracts/audit.rules.template` (`contracts/truth.md`). Outside the system under test: the monitor states it does not use the audit subsystem (`research/P1.md` section 1), and this build only installs rules and reads the log.

## Tables, never a composite

1. Headline: capture rate per harness, contract matcher, with the naive row beside it (`results.md`, `headline`, `headline_band`).
2. Write path breakdown (`write_path`).
3. Rule-by-harness matrix (`rule_matrix`).
4. Network egress (`egress`), with the boundary stated.

## What P5 must also report

- Per harness, the scenarios with an `unsupported` step (no native edit tool), as their own count. They are not in that harness's `edit` row.
- The startup paths per harness and CLI version (`run.md`, Startup exclusions).
- Every write in the `excluded` and `other` columns, by count.
- One failure case written up (BUILD_OUTLINE.md section 3, P5).
- Gemini CLI refuses the `hosts-*` writes to `/etc/hosts` in its own path check, before any syscall (DECISIONS.md, P3a). Its rule cells there are `no_event` for that reason, not because the kernel refused; say so beside the Gemini rows. Also check whether the monitor treats writes under Gemini's `--include-directories` folders differently from the other harnesses.
- The `unresolved` column per harness (truth.md, Not resolved: directory-fd-relative names).
- The `hostnames` column per harness (monitor.md, The egress join).
