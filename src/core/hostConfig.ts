/**
 * The engine-relevant slice of the host's yagami config
 * (~/.config/yagami/config.json + YAGAMI_* env) — what library mode reads so
 * an embedded `Yagami` client automatically matches the `yagami` binary on
 * the same machine: same providers, same paths, same defaults. Server-only
 * fields (host, port, apiKeys) are ignored here on purpose.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { warn } from "./log.js";
import type { ProviderConfigEntry } from "./providers/registry.js";

export function yagamiConfigDir(): string {
  return process.env["YAGAMI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "yagami");
}

/** Engine options derivable from the host machine's yagami config. */
export interface HostEngineConfig {
  defaultProvider?: string;
  defaultModel?: string;
  providerConfig?: Record<string, ProviderConfigEntry>;
  claudePath?: string;
  claudeConfigDir?: string;
}

export function loadHostEngineConfig(): HostEngineConfig {
  let file: Record<string, unknown> = {};
  const configPath = path.join(yagamiConfigDir(), "config.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    file = parsed as Record<string, unknown>;
  } catch (err) {
    // no config file — auto-detection alone is fine; a broken one is not
    // silently the same thing, because "library and binary agree" is the
    // promise and a corrupt file means they cannot
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warn("config", `ignoring ${configPath}: not valid JSON`, err);
    }
  }
  const env = process.env;
  const defaultProvider = env["YAGAMI_PROVIDER"] ?? (typeof file["defaultProvider"] === "string" ? file["defaultProvider"] : undefined);
  const defaultModel = env["YAGAMI_DEFAULT_MODEL"] ?? (typeof file["defaultModel"] === "string" ? file["defaultModel"] : undefined);
  const claudePath = env["YAGAMI_CLAUDE_PATH"] ?? (typeof file["claudePath"] === "string" ? file["claudePath"] : undefined);
  const claudeConfigDir = typeof file["claudeConfigDir"] === "string" ? file["claudeConfigDir"] : undefined;
  const providers = file["providers"];
  return {
    ...(defaultProvider ? { defaultProvider } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(providers != null && typeof providers === "object" && !Array.isArray(providers)
      ? { providerConfig: providers as Record<string, ProviderConfigEntry> }
      : {}),
    ...(claudePath ? { claudePath } : {}),
    ...(claudeConfigDir ? { claudeConfigDir } : {}),
  };
}
