// Rule-by-harness matrix cells (contracts/monitor.md, Rule-matrix cell).

// ${NAME} replaced from vars (contracts/run.md); an unknown name is an error.
function resolve(s, vars) {
  return s.replace(/\$\{([A-Z_]+)\}/g, (_, name) => {
    if (!vars || !(name in vars)) throw new Error(`unknown variable \${${name}}`);
    return vars[name];
  });
}

export function ruleCell({ ruleId, scenario, vars, truthRecords, findings } = {}) {
  if (typeof ruleId !== "string" || ruleId === "") throw new Error("ruleCell: ruleId is required");
  if (!scenario || !Array.isArray(scenario.about_rules) || !scenario.about_rules.includes(ruleId)) {
    throw new Error(`ruleCell: scenario ${scenario?.id} is not about ${ruleId}`);
  }
  const expect = new Set((scenario.expect ?? []).map((e) => resolve(e.path, vars)));
  const wrote = (truthRecords ?? []).some((r) => r.class === "headline" && expect.has(r.path));
  const fired = (findings ?? []).some((f) => f?.rule_id === ruleId);
  if (fired) return wrote ? "fired" : "fired_without_write";
  return wrote ? "not_fired" : "no_event";
}
