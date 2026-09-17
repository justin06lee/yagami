import { execFileSync } from "node:child_process";
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

/** `ps` elapsed time (`[[dd-]hh:]mm:ss`) in seconds; undefined when unparseable. */
export function parseElapsed(etime: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return undefined;
  const [, days = "0", hours = "0", minutes, seconds] = m;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/** When `pid` started, per `ps`; undefined where that cannot be asked. */
function processStartedAt(pid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    const elapsed = parseElapsed(out);
    return elapsed === undefined ? undefined : Date.now() - elapsed * 1000;
  } catch {
    return undefined;
  }
}

/**
 * Whether `state` still describes a live yagami server — not merely
 * whether *some* process has its pid. server.json outlives reboots and
 * crashes, and pids are recycled: after either, `yagami stop` used to
 * SIGTERM whatever now holds the number. A process that started after
 * the state file was written cannot be the server that wrote it.
 */
export function isServerProcess(state: ServerState, toleranceMs = 120_000): boolean {
  if (!isProcessAlive(state.pid)) return false;
  const startedAt = Date.parse(state.startedAt);
  const processStart = processStartedAt(state.pid);
  if (!Number.isFinite(startedAt) || processStart === undefined) return true;
  return processStart <= startedAt + toleranceMs;
}

/**
 * Config as stored on disk, without env overrides (safe to save back).
 *
 * A missing file means defaults. A file that exists but cannot be parsed is
 * an error, not defaults: treating it as empty used to make the next
 * `yagami start` generate a key and save "defaults plus key" over the
 * user's providers and settings.
 */
export function loadFileConfig(): YagamiConfig {
  let fromFile: Partial<YagamiConfig> = {};
  const file = configFilePath();
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`cannot read config file ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`config file ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix or remove it`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`config file ${file} must contain a JSON object; fix or remove it`);
    }
    fromFile = parsed as Partial<YagamiConfig>;
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
