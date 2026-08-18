import { serve, type ServerType } from "@hono/node-server";
import { YagamiEngine } from "./core/engine.js";
import { SessionCache } from "./core/sessionCache.js";
import { createApp } from "./server/app.js";
import {
  loadConfig,
  sessionCachePath,
  type YagamiConfig,
} from "./server/config.js";
import { VERSION } from "./version.js";

export interface RunningServer {
  server: ServerType;
  engine: YagamiEngine;
  config: YagamiConfig;
  url: string;
  close(): Promise<void>;
}

/**
 * Start a yagami server. Overrides are merged over the loaded config
 * (~/.config/yagami/config.json plus YAGAMI_* env vars).
 */
export async function startYagami(overrides: Partial<YagamiConfig> = {}): Promise<RunningServer> {
  const config: YagamiConfig = { ...loadConfig(), ...definedProps(overrides) };
  if (config.apiKeys.length === 0) {
    throw new Error(
      "no API keys configured — run `yagami keygen` (or set YAGAMI_API_KEY) so the endpoint isn't unauthenticated",
    );
  }

  const engine = new YagamiEngine({
    claudePath: config.claudePath,
    claudeConfigDir: config.claudeConfigDir,
    defaultModel: config.defaultModel,
    sessionCache: new SessionCache({ persistPath: sessionCachePath() }),
  });

  const app = createApp({ engine, apiKeys: config.apiKeys, cors: config.cors, version: VERSION });

  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    server,
    engine,
    config: { ...config, port },
    url: `http://${config.host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function definedProps<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export { createApp } from "./server/app.js";
export type { AppOptions, EngineLike } from "./server/app.js";
export {
  loadConfig,
  loadFileConfig,
  saveConfig,
  generateApiKey,
  configFilePath,
  sessionCachePath,
  yagamiConfigDir,
  type YagamiConfig,
} from "./server/config.js";
