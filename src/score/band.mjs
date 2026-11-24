// Rates and five-run bands (contracts/results.md).

function count(n, name) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`rate: ${name} must be a non-negative integer`);
}

export function rate(numerator, denominator) {
  count(numerator, "numerator");
  count(denominator, "denominator");
  if (numerator > denominator) throw new Error("rate: numerator is larger than denominator");
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function band(rates) {
  const xs = (Array.isArray(rates) ? rates : []).filter((r) => r !== null && r !== undefined);
  for (const r of xs) if (typeof r !== "number" || !(r >= 0 && r <= 1)) throw new Error(`band: rate ${r} is not in [0, 1]`);
  if (xs.length === 0) throw new Error("band: no rates");
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return { min: s[0], median, max: s[n - 1], n };
}
