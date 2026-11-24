# Security

Open items, rendered into the README in P6. Severity: high, medium, low.

| ID | Severity | Item | Owner | Workaround | Status |
|---|---|---|---|---|---|
| T-1 | low | `ci` runs the PR's own copy of `ci.yml`, so a PR that edits it could post statuses with the workflow token. | Tony | `forge/guard` (base copy) fails any PR that touches `.github/`, and review reads the diff. | open |
| T-2 | low | gitleaks honours inline `gitleaks:allow` comments; a PR could mark a line as allowed. | Tony | Review greps the diff for `gitleaks:allow`. | open |
| T-3 | low | Under the box's `landlock` profile, TCP rules name ports, not addresses: the model port and the proxy (ephemeral) port range are open to any host, not only 127.0.0.1. | Tony | Only for projects with `eval_boundary: landlock`; the box's nftables rules and the proxies' own allowlists still apply. | open |
| T-4 | low | A harness whose base URL is not set falls back to its vendor's API and sends the dummy credential and the scenario prompt there. It happened once in P2 while the smoke script was being written (one request to the vendor's API with the token `hb-dummy-not-a-key`, refused with 401). | P3a | Every adapter sets the base URL from the scripted server (red test P3a-adapter-points-at-server). In the P3a live check every run of every pinned CLI reached the scripted server (`tests/model/live.test.mjs`). That shows the base URL was used. It does not show that nothing else left the machine, so box runs still limit the network to 127.0.0.1 (scripts/eval.sh, P4 and P5). | open |
