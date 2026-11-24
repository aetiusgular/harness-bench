// Helpers for lane P3a's own tests.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const json = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));
export const LOCK = json("models.lock");
export const R1 = { WS: "/tmp/hb-r1/ws", HOME: "/tmp/hb-r1/home", OUT: "/tmp/hb-r1/out" };

export function scenario(id) {
  for (const rel of [`fixtures/scenarios/dev/${id}.json`, `fixtures/scenarios/heldout/${id}.json`, `fixtures/calibration/${id}.json`]) {
    try {
      return json(rel);
    } catch {}
  }
  throw new Error(`no scenario ${id}`);
}

export async function postJson(url, body, method = "POST") {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
}
