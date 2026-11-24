// Path variables in scenario strings (contracts/run.md, Path variables).
// Only ${WS}, ${HOME} and ${OUT}; any other name is an error.

const ALLOWED = new Set(["WS", "HOME", "OUT"]);
const VAR = /\$\{([^}]*)\}/g;

function one(s, vars) {
  return s.replace(VAR, (_, name) => {
    if (!ALLOWED.has(name) || typeof vars?.[name] !== "string") throw new Error(`unknown variable \${${name}}`);
    return vars[name];
  });
}

/** Every string in `value` (any depth) with its variables replaced. */
export function substitute(value, vars) {
  if (typeof value === "string") return one(value, vars);
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}
