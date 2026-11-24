// Helpers for the P4 cross-lane tests.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
export const json = (rel) => JSON.parse(read(rel));
export const FAKE_CLI = path.join(ROOT, "tests/integration/fake-cli.mjs");

export function scenarios(split) {
  const dir = path.join(ROOT, "fixtures/scenarios", split);
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));
}

// One auditd event as RAW text lines.
export function auditEvent(serial, { ts = 1764000000.5, syscall, success = "yes", exit = "0", a0 = "ffffff9c", a1 = "0", a2 = "0", pid = 4100, ppid = 4000, exe = "/usr/bin/sh", cwd = "/r/ws", paths = [], saddr = null, key = "hb_write" }) {
  const t = `${ts.toFixed(3)}:${serial}`;
  const lines = [
    `type=SYSCALL msg=audit(${t}): arch=c000003e syscall=${syscall} success=${success} exit=${exit} a0=${a0} a1=${a1} a2=${a2} a3=0 items=${paths.length} ppid=${ppid} pid=${pid} auid=1000 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=pts1 ses=3 comm="sh" exe="${exe}" subj=unconfined key="${key}"`,
  ];
  if (saddr) lines.push(`type=SOCKADDR msg=audit(${t}): saddr=${saddr}`);
  lines.push(`type=CWD msg=audit(${t}): cwd="${cwd}"`);
  paths.forEach(([name, nametype], i) => lines.push(`type=PATH msg=audit(${t}): item=${i} name="${name}" inode=1 dev=08:01 mode=0100644 ouid=1000 ogid=1000 rdev=00:00 nametype=${nametype} cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0`));
  lines.push(`type=EOE msg=audit(${t}):`);
  return lines.join("\n");
}

export const CTX = { run_id: "r", root_pid: 4100, start: 1764000000, end: 1764000100, workspace: "/r/ws", home: "/r/home", exclude: { monitor_exe_prefixes: [], model_server_pids: [], startup_paths: [] } };
