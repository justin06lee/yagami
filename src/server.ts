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
  sessionCache: SessionCache;
  config: YagamiConfig;
  url: string;
  close(): Promise<void>;
}

export interface StartOptions extends Partial<YagamiConfig> {
  /** Sink for one-line request logs (default: console.log). Pass null to disable. */
  log?: ((line: string) => void) | null;
}

/**
 * Start a yagami server. Overrides are merged over the loaded config
 * (~/.config/yagami/config.json plus YAGAMI_* env vars).
 */
export async function startYagami(overrides: StartOptions = {}): Promise<RunningServer> {
  const { log, ...configOverrides } = overrides;
  const config: YagamiConfig = { ...loadConfig(), ...definedProps(configOverrides) };
  if (config.apiKeys.length === 0) {
    throw new Error(
      "no API keys configured — run `yagami keygen` (or set YAGAMI_API_KEY) so the endpoint isn't unauthenticated",
    );
  }

  const sessionCache = new SessionCache({ persistPath: sessionCachePath() });
  const engine = new YagamiEngine({
    ...(config.providers ? { providerConfig: config.providers } : {}),
    ...(config.defaultProvider ? { defaultProvider: config.defaultProvider } : {}),
    ...(config.claudePath ? { claudePath: config.claudePath } : {}),
    ...(config.claudeConfigDir ? { claudeConfigDir: config.claudeConfigDir } : {}),
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    sessionCache,
    appName: "yagami",
  });

  const app = createApp({
    engine,
    apiKeys: config.apiKeys,
    cors: config.cors,
    version: VERSION,
    ...(log === null ? {} : { log: log ?? ((line: string) => console.log(line)) }),
  });

  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    server,
    engine,
    sessionCache,
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
  serverStatePath,
  logFilePath,
  readServerState,
  writeServerState,
  clearServerState,
  isProcessAlive,
  yagamiConfigDir,
  type YagamiConfig,
  type ServerState,
} from "./server/config.js";
