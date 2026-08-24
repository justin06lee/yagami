import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { yagamiConfigDir } from "../core/hostConfig.js";
import type { ProviderConfigEntry } from "../core/providers/registry.js";

export { yagamiConfigDir } from "../core/hostConfig.js";

export interface YagamiConfig {
  host: string;
  port: number;
  apiKeys: string[];
  /** @deprecated Use providers.claude.path. */
  claudePath?: string;
  /** @deprecated Use providers.claude.configDir. */
  claudeConfigDir?: string;
  defaultModel?: string;
  cors?: boolean;
  /** Provider used for bare model ids (default: claude). */
  defaultProvider?: string;
  /** Per-provider settings, keyed by provider id. */
  providers?: Record<string, ProviderConfigEntry>;
}

export const DEFAULT_CONFIG: YagamiConfig = {
  host: "127.0.0.1",
  port: 8787,
  apiKeys: [],
};

export function configFilePath(): string {
  return path.join(yagamiConfigDir(), "config.json");
}

export function sessionCachePath(): string {
  return path.join(yagamiConfigDir(), "sessions.json");
}

export function serverStatePath(): string {
  return path.join(yagamiConfigDir(), "server.json");
}

export function logFilePath(): string {
  return path.join(yagamiConfigDir(), "yagami.log");
}

/** What a running server records about itself for `stop`/`status`. */
export interface ServerState {
  pid: number;
  host: string;
  port: number;
  url: string;
  startedAt: string;
  version: string;
  log?: string;
}

export function readServerState(): ServerState | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(serverStatePath(), "utf8")) as ServerState;
    return typeof state?.pid === "number" ? state : undefined;
  } catch {
    return undefined;
  }
}

export function writeServerState(state: ServerState): void {
  fs.mkdirSync(yagamiConfigDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(serverStatePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Remove the state file; with `pid`, only if it still belongs to that pid. */
export function clearServerState(pid?: number): void {
  try {
    if (pid !== undefined && readServerState()?.pid !== pid) return;
    fs.unlinkSync(serverStatePath());
  } catch {
    // already gone
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  if (env["YAGAMI_PROVIDER"]) cfg.defaultProvider = env["YAGAMI_PROVIDER"];
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
