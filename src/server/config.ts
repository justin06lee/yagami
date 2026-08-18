import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface YagamiConfig {
  host: string;
  port: number;
  apiKeys: string[];
  claudePath?: string;
  claudeConfigDir?: string;
  defaultModel?: string;
  cors?: boolean;
}

export const DEFAULT_CONFIG: YagamiConfig = {
  host: "127.0.0.1",
  port: 8787,
  apiKeys: [],
};

export function yagamiConfigDir(): string {
  return process.env["YAGAMI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "yagami");
}

export function configFilePath(): string {
  return path.join(yagamiConfigDir(), "config.json");
}

export function sessionCachePath(): string {
  return path.join(yagamiConfigDir(), "sessions.json");
}

/** Config as stored on disk, without env overrides (safe to save back). */
export function loadFileConfig(): YagamiConfig {
  let fromFile: Partial<YagamiConfig> = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(configFilePath(), "utf8")) as Partial<YagamiConfig>;
  } catch {
    // no config file yet
  }
  return {
    ...DEFAULT_CONFIG,
    ...fromFile,
    apiKeys: Array.isArray(fromFile.apiKeys) ? fromFile.apiKeys.filter((k) => typeof k === "string") : [],
  };
}

/** File config plus environment overrides. */
export function loadConfig(): YagamiConfig {
  const cfg = loadFileConfig();
  const env = process.env;
  if (env["YAGAMI_HOST"]) cfg.host = env["YAGAMI_HOST"];
  if (env["YAGAMI_PORT"] && Number.isFinite(Number(env["YAGAMI_PORT"]))) {
    cfg.port = Number(env["YAGAMI_PORT"]);
  }
  if (env["YAGAMI_API_KEY"] && !cfg.apiKeys.includes(env["YAGAMI_API_KEY"])) {
    cfg.apiKeys.push(env["YAGAMI_API_KEY"]);
  }
  if (env["YAGAMI_CLAUDE_PATH"]) cfg.claudePath = env["YAGAMI_CLAUDE_PATH"];
  if (env["YAGAMI_DEFAULT_MODEL"]) cfg.defaultModel = env["YAGAMI_DEFAULT_MODEL"];
  return cfg;
}

export function saveConfig(cfg: YagamiConfig): string {
  const dir = yagamiConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configFilePath();
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function generateApiKey(): string {
  return `ygm_${randomBytes(24).toString("hex")}`;
}

export function maskKey(key: string): string {
  return key.length <= 12 ? key : `${key.slice(0, 12)}…`;
}
