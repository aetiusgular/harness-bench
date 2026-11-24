// auditd rule set from contracts/audit.rules.template (contracts/api.md, lane P3b).

import { readFileSync } from "node:fs";

const TEMPLATE = new URL("../../contracts/audit.rules.template", import.meta.url);

// The template with @UID@ replaced and nothing else changed. The uid is the
// run user's (contracts/run.md, Run user); root is refused so no run can
// write the machine's real /etc/hosts.
export function renderRules({ uid } = {}) {
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("renderRules: uid must be a non-negative integer");
  }
  if (uid === 0) throw new Error("renderRules: uid 0 (root) is refused");
  return readFileSync(TEMPLATE, "utf8").replaceAll("@UID@", String(uid));
}
