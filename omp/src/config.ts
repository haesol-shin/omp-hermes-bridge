import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface BridgeConfig {
  root: string;
  hostId: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

export type ConfigResult = { config: BridgeConfig } | { problem: string };

export const CONFIG_FILE = "hermes-bridge.json";
export const CONFIG_ENV = "OMP_HERMES_BRIDGE_CONFIG";

export function configPath(agentDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[CONFIG_ENV] || join(agentDir, CONFIG_FILE);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The HMAC secret is used byte for byte; trimming it would change every signature. */
function secret(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function expandRoot(value: string, agentDir: string): string {
  if (value === "~" || value.startsWith("~/")) return join(homedir(), value.slice(1));
  return isAbsolute(value) ? value : resolve(agentDir, value);
}

/**
 * Reads the single 0600 config file. Keys use the contract's names (`bridge.root`, ...).
 * The file holds the webhook secret, so a group/world-readable file is refused rather than used.
 */
export function loadConfig(agentDir: string, env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const file = configPath(agentDir, env);
  if (!existsSync(file)) return { problem: `no config file at ${file}` };
  const mode = statSync(file).mode;
  if ((mode & 0o077) !== 0) return { problem: `${file} must be mode 0600` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { problem: `${file} is not valid JSON` };
  }
  if (typeof raw !== "object" || raw === null) return { problem: `${file} must hold a JSON object` };
  const values = raw as Record<string, unknown>;
  const hostId = str(values["bridge.host_id"]);
  if (!hostId) return { problem: "bridge.host_id is required" };
  const root = str(values["bridge.root"]);
  return {
    config: {
      root: root ? expandRoot(root, agentDir) : join(agentDir, "hermes-bridge"),
      hostId,
      webhookUrl: str(values["bridge.webhook_url"]),
      webhookSecret: secret(values["bridge.webhook_secret"]),
    },
  };
}

/** Re-reads the file only when it changed, so a config edited during a long session takes effect. */
export class ConfigStore {
  #key = "";
  #value: ConfigResult = { problem: "not loaded" };
  constructor(
    private readonly agentDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get(): ConfigResult {
    const file = configPath(this.agentDir, this.env);
    let key: string;
    try {
      const st = statSync(file);
      key = `${st.mtimeMs}:${st.size}:${st.mode}`;
    } catch {
      key = "missing";
    }
    if (key !== this.#key) {
      this.#key = key;
      this.#value = loadConfig(this.agentDir, this.env);
    }
    return this.#value;
  }
}
