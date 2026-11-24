# Decisions

Every call made in a phase, newest last. "agent's call" for rule 2 of BUILD_OUTLINE.md section 2 (reversible, inside the session's own folders); "Tony's call" for anything Tony decided. Each entry has its reason and what would reverse it.

| Date | Phase | Call | Decision | Reason | Reverse if |
|---|---|---|---|---|---|
| 2026-11-23 | P0 | agent's call | Repo standard from forge commit 65e468cfd948 (template/, BUILD_OUTLINE.md section 7). | P0 init by the forge bootstrap session; the per-file reasons are in forge's DECISIONS.md. | the template changes before P1 starts |
| 2026-11-23 | P1 | agent's call | Pick candidate A, the capture-vs-kernel matrix with a keyless scripted model (23), over B, the boundary containment matrix (18), and C, the credential-read table (18). | Highest rubric total. B and C lose on "customers feel it" and "not a clone" (research/P1.md section 4). | a review finding with evidence reopens it (Tony gate) |
| 2026-11-23 | P1 | agent's call | Headline: per-harness capture rate of out-of-workspace file writes against auditd. Egress becomes a secondary table. | A file write has one kernel record per path. Under srt, egress goes through a proxy, so the kernel's connect record does not name the final host. | P2 finds auditd cannot attribute writes to the harness's process tree |
| 2026-11-23 | P1 | agent's call | First harness set: Claude Code, Codex CLI, Gemini CLI, OpenCode. | Each has a documented collection path in the monitor and a fake-model pattern in derm. | a keyless path fails in P2: drop that harness and log it |
| 2026-11-23 | P1 | agent's call | The monitor's product name stays out of SPEC.md. It is named only in research/P1.md. | Standing constraint: company and product names only in README prose and research notes. | — |
| 2026-11-23 | P1 | agent's call | The brief's "25 harnesses, 18 contract-tested" for derm is not repeated anywhere. | It was not reproduced: derm's preset index lists 18 harnesses and 11 planned (research/P1.md section 5). | derm publishes a count that matches |
