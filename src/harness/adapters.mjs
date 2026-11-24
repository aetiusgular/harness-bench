// Per-harness launch: argv, environment and config files that point a pinned CLI at the scripted server.
// Lane P3a (contracts/api.md). The launch lines follow what each pinned CLI
// did in the P2 keyless smoke (scripts/p2-keyless-smoke.mjs,
// results/p2-keyless-smoke.jsonl) and in this lane's live check
// (tests/model/live.test.mjs, README.md "Lane P3a").

import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOCK = JSON.parse(readFileSync(fileURLToPath(new URL("../../models.lock", import.meta.url)), "utf8"));

// The only credential any harness is given. It is not a key for any service.
export const DUMMY_CREDENTIAL = "hb-dummy-not-a-key";
const MODEL = "fake-model";

// HOME and the XDG folders all point into the run home, so nothing a CLI
// writes at start-up lands in the real home of the run account.
function baseEnv(home) {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    NO_COLOR: "1",
  };
}

const toml = (s) => JSON.stringify(String(s));

const ADAPTERS = {
  "claude-code": ({ home, modelUrl, prompt }) => ({
    args: ["-p", prompt, "--dangerously-skip-permissions", "--model", "claude-sonnet-4-5"],
    env: {
      ANTHROPIC_BASE_URL: modelUrl,
      ANTHROPIC_AUTH_TOKEN: DUMMY_CREDENTIAL,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    files: {},
  }),

  codex: ({ home, modelUrl, prompt }) => {
    const codexHome = path.join(home, ".codex");
    const config = [
      `model_provider = "hb"`,
      `model = ${toml(MODEL)}`,
      `check_for_update_on_startup = false`,
      ``,
      `[model_providers.hb]`,
      `name = "hb"`,
      `base_url = ${toml(modelUrl)}`,
      `wire_api = "responses"`,
      `env_key = "HB_MODEL_KEY"`,
      `requires_openai_auth = false`,
      `supports_websockets = false`,
      `request_max_retries = 0`,
      `stream_max_retries = 0`,
      ``,
      `[analytics]`,
      `enabled = false`,
      ``,
    ].join("\n");
    return {
      args: ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt],
      env: { CODEX_HOME: codexHome, HB_MODEL_KEY: DUMMY_CREDENTIAL },
      files: { [path.join(codexHome, "config.toml")]: config },
    };
  },

  // Gemini CLI's write_file refuses any path outside its workspace
  // directories, and no setting turns that off at 0.71.1. The run home and
  // R/out (contracts/run.md: R/ws, R/home and R/out are siblings) are added
  // with --include-directories, so an edit step reaches the kernel as it does
  // for the other three harnesses. Paths outside R (the hosts-* scenarios'
  // /etc/hosts) are still refused by the CLI before any syscall
  // (DECISIONS.md, P3a).
  "gemini-cli": ({ workspace, home, modelUrl, prompt }) => ({
    args: ["-p", prompt, "-y", "-m", MODEL, "--include-directories", `${home},${path.join(path.dirname(workspace), "out")}`],
    env: {
      GEMINI_API_KEY: DUMMY_CREDENTIAL,
      GOOGLE_GEMINI_BASE_URL: modelUrl,
      GEMINI_CLI_TRUST_WORKSPACE: "true",
      GEMINI_CLI_NO_RELAUNCH: "true",
    },
    files: {
      [path.join(home, ".gemini", "settings.json")]: JSON.stringify(
        {
          security: { auth: { selectedType: "gemini-api-key" } },
          general: { disableAutoUpdate: true, disableUpdateNag: true },
          privacy: { usageStatisticsEnabled: false },
        },
        null,
        2,
      ) + "\n",
    },
  }),

  opencode: ({ workspace, modelUrl, prompt }) => ({
    args: ["run", prompt],
    env: { OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1" },
    files: {
      [path.join(workspace, "opencode.json")]: JSON.stringify(
        {
          provider: {
            hb: {
              npm: "@ai-sdk/openai-compatible",
              name: "hb",
              options: { baseURL: modelUrl, apiKey: DUMMY_CREDENTIAL },
              models: { [MODEL]: { name: MODEL } },
            },
          },
          model: `hb/${MODEL}`,
          permission: { edit: "allow", bash: "allow", external_directory: "allow" },
          autoupdate: false,
          share: "disabled",
        },
        null,
        2,
      ) + "\n",
    },
  }),
};

function inside(p, root) {
  return p.startsWith(root.endsWith("/") ? root : root + "/");
}

export function adapterFor(harness) {
  const lock = Object.hasOwn(LOCK.harnesses, harness) ? LOCK.harnesses[harness] : null;
  const make = Object.hasOwn(ADAPTERS, harness) ? ADAPTERS[harness] : null;
  if (!lock || !make) throw new Error(`unknown harness ${harness}`);
  return {
    id: harness,
    wire: lock.wire,
    command({ bin, workspace, home, modelUrl, prompt, runEnv = {} }) {
      for (const [k, v] of Object.entries({ bin, workspace, home, modelUrl })) {
        if (typeof v !== "string" || !v) throw new Error(`${harness}: ${k} is required`);
      }
      if (!path.isAbsolute(workspace) || !path.isAbsolute(home)) throw new Error(`${harness}: workspace and home must be absolute`);
      const spec = make({ workspace: path.resolve(workspace), home: path.resolve(home), modelUrl, prompt: String(prompt ?? "") });
      const files = {};
      for (const [f, text] of Object.entries(spec.files)) {
        const p = path.resolve(f);
        if (!inside(p, path.resolve(home)) && !inside(p, path.resolve(workspace))) throw new Error(`${harness}: config file ${p} is outside home and workspace`);
        files[p] = text;
      }
      return {
        argv: [bin, ...spec.args],
        env: { ...baseEnv(path.resolve(home)), ...spec.env, ...runEnv },
        cwd: workspace,
        files,
      };
    },
  };
}
