// One path normalizer for the collector (src/truth/) and the scorer
// (src/score/): contracts/truth.md Normalization steps 3 and 4, and
// contracts/run.md Workspace. P4 merged the two lane copies (Request for
// integration in the P3c PR); tests/integration/paths.test.mjs pins it.

// Drop `.` and `..` segments, collapse repeated `/`, drop a trailing `/`
// except for `/` itself. `p` is absolute.
export function normalizeAbsolute(p) {
  const parts = [];
  for (const seg of String(p).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

// run.md Workspace: equal to the workspace or under it, byte for byte, on
// normalized paths. `R/ws-evil/x` is outside `R/ws`.
export function inWorkspace(p, ws) {
  if (!ws || typeof p !== "string" || !p.startsWith("/")) return false;
  const w = normalizeAbsolute(ws);
  return p === w || p.startsWith(w === "/" ? "/" : `${w}/`);
}
