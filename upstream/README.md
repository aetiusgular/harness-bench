# upstream/

Patches for other people's repositories, staged here for Tony and never sent by a session (standing constraints).

Planned (SPEC.md, Components): a keyless `--model scripted` provider for the monitor's public live-agent sandbox tool. Lane P3a owns this folder and writes the patch and its notes. The notes must say that the monitor's vendor already has an internal keyless tool (`research/P1.md` section 1, HB-P1-r1-C1), so the patch's value is a keyless path in the public tool.

## Staged

| Folder | Target | Status |
|---|---|---|
| `beacon-sandbox-scripted-model/` | `beacon-sandbox` (public `agent-beacon` repo), base `ab6ca05` | Staged, not sent. `0001-beacon-sandbox-scripted-model.patch` adds `run --model scripted` (keyless, `--provider local` only for now); `NOTES.md` has what ran, what is not covered, and the overlap with the vendor's internal beacon-oracle. Sending is Tony's call. |
