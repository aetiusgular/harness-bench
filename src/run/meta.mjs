// Section 6 fields read at run time (contracts/results.md, BUILD_OUTLINE.md
// section 6 items 7 and 8). The machine label is never copied from a notes file.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function machineLabel(env = process.env) {
  if (env.FORGE_MACHINE_FILE) {
    try {
      return readFileSync(env.FORGE_MACHINE_FILE, "utf8").trim();
    } catch {}
  }
  const parts = [];
  try {
    const cpu = /^model name\s*:\s*(.+)$/m.exec(readFileSync("/proc/cpuinfo", "utf8"));
    if (cpu) parts.push(cpu[1].trim());
  } catch {}
  try {
    const mem = /^MemTotal:\s*(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"));
    if (mem) parts.push(`${Math.round(Number(mem[1]) / 1048576)} GiB RAM`);
  } catch {}
  try {
    const gpu = execFileSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
    if (gpu) parts.push(gpu.split("\n")[0]);
  } catch {}
  return parts.join("; ") || "unknown";
}

export function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

// model_revision is the split hash (models.lock, contracts/results.md).
export function splitHash() {
  const m = /^split-sha256: *([0-9a-f]{64})/m.exec(readFileSync(new URL("../../contracts/eval.md", import.meta.url), "utf8"));
  if (!m) throw new Error("contracts/eval.md has no split-sha256");
  return m[1];
}

export function section6({ runId, env = process.env } = {}) {
  return {
    run_id: runId,
    git_sha: gitSha(),
    machine: machineLabel(env),
    model_revision: splitHash(),
    quant: null,
    runtime: `node ${process.version}`,
    date: new Date().toISOString(),
  };
}
