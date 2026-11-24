# Module seams

Plain ES modules, Node 22 or later, no build step, no runtime dependency except `derm-workspace` (pinned in `package.json`; `models.lock`). Each function below exists in P2 as a stub that throws `Error("HB not implemented: <module>.<function>")`. A lane replaces its stubs; it does not rename, move or change the signature of anything here. A seam change is a Request for integration.

## Lane P3a: scripted model server and harness adapters

`src/model/server.mjs`

```js
startServer({ scenario, harness, vars, host = "127.0.0.1", port = 0 })
  // -> Promise<{ url, port, requests, transcript, close }>
```

- `scenario`: a parsed `hb-scenario/1` object. `harness`: a key of `models.lock` `harnesses`. `vars`: `{ WS, HOME, OUT }` (`run.md`).
- Rejects with `unknown variable ${NAME}` if any scenario string uses a variable not in `vars`, and with `unknown harness <name>` for a harness not in `models.lock`.
- Listens on `host` only. `url` is the base URL the harness is given: `http://127.0.0.1:<port>` for `anthropic-messages` and `gemini`, `http://127.0.0.1:<port>/v1` for `openai-responses` and `openai-chat` (the `wire` in `models.lock`).
- Speaks the harness's wire format, streaming when the request asks for it. A turn request (one that offers tools) gets the next step of `scenario.steps` as a tool call, mapped as `scenario.md` Neutral actions says. After the last step it gets `final_text` and a stop reason that ends the turn. A side request (offers no tools: a title, a summary, a token count) never advances the script. On the Gemini wire the CLI sends turns as `:streamGenerateContent`; a plain `:generateContent` or `:countTokens` request is a side request (derm's `fakeGemini.mjs` routes them the same way).
- `requests`: every request seen, `{ at, method, url, kind: "turn" | "side" | "other", body }`. `transcript`: one entry per step, `{ step, action, tool, status: "sent" | "unsupported" }`.
- Any other method or path gets a 404 JSON error and the server stays up.
- `close()` resolves when the port is free.

Lane P3a may build on derm's fake servers (`derm-workspace/tests/cli-contract/lib/fake*.mjs`), imported, not copied.

`src/harness/adapters.mjs`

```js
adapterFor(harness)
  // -> { id, wire, command({ bin, workspace, home, modelUrl, prompt, runEnv = {} }) -> { argv, env, cwd, files } }
```

- Throws `unknown harness <name>`.
- `argv[0]` is `bin`. `cwd` is `workspace`. `env` is built from nothing: `PATH`, `HOME = home`, the variables that point the harness at `modelUrl`, a dummy credential that starts with `hb-dummy-`, telemetry and update switches, and then `runEnv` on top. No value from the parent process's environment other than `PATH` is passed through.
- `files`: `{ <absolute path under home or workspace>: <text> }` config files the runner writes before the spawn (for example a provider config). Never outside `home` or `workspace`.
- The harness runs non-interactively with tool approvals off, so the scripted calls execute.

## Lane P3b: ground-truth collector

`src/truth/rules.mjs`

```js
renderRules({ uid }) // -> string: contracts/audit.rules.template with @UID@ replaced; throws "renderRules: uid must be a non-negative integer"
```

`uid` 0 is refused with `renderRules: uid 0 (root) is refused` (`run.md`, Run user).

`src/truth/parse.mjs`

```js
parseAuditLog(text) // -> Event[] in serial order
// Event: { serial, ts, syscall (name), success (bool), exit (string), a0, a1, a2, pid, ppid, comm, exe, key, cwd, paths: [{ item, name, nametype }], execve: [args] | null, saddr: <hex string> | null }
```

`name` is decoded (hex to text). `syscall` is the x86_64 name for the number.

`src/truth/collect.mjs`

```js
collectWrites(text, context) // -> TruthRecord[] (contracts/truth.md, Output record), serial order
```

`context` is `run.md` `run.json`.

```js
collectConnects(text, context) // -> ConnectRecord[] (contracts/truth.md, Connect records), serial order
```

## Lane P3c: monitor reader, matcher and scorer

`src/score/monitor.mjs`

```js
parseMonitorLog(text, { home, workspace }) // -> { events: MonitorEvent[], bad_lines }
// MonitorEvent: { timestamp, sequence, action, harness, collection_method, fidelity, paths: [distinct normalized absolute paths] }
commandPaths(command, { home, base }) // -> string[]: monitor.md, Paths in a command line, normalized
parseFindings(text) // -> Finding[] ({ rule_id, session_id, ... }); null and [] give []
```

`src/score/match.mjs`

```js
matchWrites(truthRecords, monitorEvents, { matcher = "contract" | "naive", rawEvents })
  // -> { numerator, denominator, rate, matched: [paths], missed: [paths], excluded: {monitor, model_server, startup},
  //      other: {other_syscall, openat2_unclassified, denied, unresolved}, in_workspace }
```

`matched` and `missed` are sorted. `rawEvents` (the parsed JSON lines) is what the naive matcher reads.

```js
matchEgress(connectRecords, rawEvents)
  // -> { connects, named, matched: [endpoints], missed: [endpoints], loopback, failed, excluded: {monitor, model_server}, hostnames: [hosts] }
```

`contracts/monitor.md`, The egress join. `matched`, `missed` and `hostnames` are sorted.

`src/score/band.mjs`

```js
rate(numerator, denominator) // -> number | null
band(rates)                  // -> { min, median, max, n }; throws "band: no rates"
```

`src/score/rows.mjs`

```js
makeRow(table, fields) // -> row object; throws "missing field: <name>" for a section 6, common or table field (contracts/results.md)
```

`src/score/rulematrix.mjs`

```js
ruleCell({ ruleId, scenario, vars, truthRecords, findings }) // -> "fired" | "not_fired" | "no_event" | "fired_without_write"
```

## P4 and later

The runner (spawn, setup, audit window, results writing) and `scripts/eval.sh` are P4 and P5 work. They use only the functions above.
