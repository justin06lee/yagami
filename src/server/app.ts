import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError, type MessagesRequest } from "../core/types.js";
import { toApiError } from "../core/errors.js";
import type { CompleteResult, EngineModel, StreamOptions, StreamStart } from "../core/engine.js";

/** What the app needs from an engine — lets tests inject a fake. */
export interface EngineLike {
  /** Executable of the default provider. */
  executable: string;
  defaultProviderId: string;
  providerIds: string[];
  complete(req: MessagesRequest): Promise<CompleteResult>;
  stream(req: MessagesRequest, opts?: StreamOptions): StreamStart;
  listModels(): Promise<EngineModel[]>;
}

export interface AppOptions {
  engine: EngineLike;
  apiKeys: string[];
  cors?: boolean;
  version?: string;
  /** Sink for one-line request logs; omit to disable request logging. */
  log?: (line: string) => void;
}

/** Served by GET /v1/models only when probing the CLI fails. */
const FALLBACK_MODELS: EngineModel[] = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
].map((id) => ({ id, display_name: id }));

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function errorBody(type: ApiError["type"], message: string) {
  return { type: "error" as const, error: { type, message } };
}

function requestLine(
  status: number,
  model: string,
  startedAt: number,
  extra: { cost?: number; session?: string; stream?: boolean; error?: string } = {},
): string {
  const parts = [
    new Date().toISOString(),
    `POST /v1/messages ${status}`,
    `model=${model}`,
    `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  ];
  if (extra.stream) parts.push("stream");
  if (extra.cost !== undefined) parts.push(`cost=$${extra.cost.toFixed(6)}`);
  if (extra.session) parts.push(`session=${extra.session}`);
  if (extra.error) parts.push(`error=${extra.error}`);
  return parts.join(" ");
}

export function createApp(options: AppOptions): Hono {
  const { engine, apiKeys, log } = options;
  const app = new Hono();
  const stats = { startedAt: Date.now(), requests: 0, totalCostUsd: 0 };

  if (options.cors) app.use("*", cors());

  app.use("*", async (c, next) => {
    c.header("request-id", `req_${randomUUID().replace(/-/g, "")}`);
    await next();
  });

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      service: "yagami",
      version: options.version,
      provider: engine.defaultProviderId,
      providers: engine.providerIds,
      executable: engine.executable,
      uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
      requests: stats.requests,
      total_cost_usd: stats.totalCostUsd,
    }),
  );

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("x-api-key") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const ok = header != null && apiKeys.some((key) => safeEqual(key, header));
    if (!ok) {
      return c.json(errorBody("authentication_error", "invalid x-api-key"), 401);
    }
    await next();
  });

  app.get("/v1/models", async (c) => {
    let models = FALLBACK_MODELS;
    let source = "fallback";
    try {
      const probed = await engine.listModels();
      if (probed.length > 0) {
        models = probed;
        source = "engine";
      }
    } catch {
      // engine unavailable or slow — the static list keeps clients working
    }
    c.header("x-yagami-models-source", source);
    return c.json({
      data: models.map((m) => ({ type: "model", ...m })),
      has_more: false,
      first_id: models[0]?.id,
      last_id: models[models.length - 1]?.id,
    });
  });

  app.post("/v1/messages", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("invalid_request_error", "request body must be valid JSON"), 400);
    }
    const req = body as MessagesRequest;
    const startedAt = Date.now();
    const model = typeof req.model === "string" ? req.model : "(default)";
    stats.requests += 1;

    try {
      if (req.stream === true) {
        const abortController = new AbortController();
        const { ignored, provider, events } = engine.stream(req, {
          signal: abortController.signal,
          onResult: (info) => {
            if (info.costUsd !== undefined) stats.totalCostUsd += info.costUsd;
            log?.(
              requestLine(200, model, startedAt, {
                stream: true,
                ...(info.costUsd !== undefined ? { cost: info.costUsd } : {}),
                ...(info.sessionId ? { session: info.sessionId } : {}),
              }),
            );
          },
        });
        c.header("x-yagami-provider", provider);
        if (ignored.length > 0) c.header("x-yagami-ignored", ignored.join(","));
        return streamSSE(c, async (stream) => {
          stream.onAbort(() => abortController.abort());
          for await (const ev of events) {
            await stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) });
          }
        });
      }

      const result = await engine.complete(req);
      if (result.costUsd !== undefined) stats.totalCostUsd += result.costUsd;
      log?.(
        requestLine(200, model, startedAt, {
          ...(result.costUsd !== undefined ? { cost: result.costUsd } : {}),
          ...(result.sessionId ? { session: result.sessionId } : {}),
        }),
      );
      c.header("x-yagami-provider", result.provider);
      if (result.ignored.length > 0) c.header("x-yagami-ignored", result.ignored.join(","));
      if (result.costUsd !== undefined) c.header("x-yagami-cost-usd", result.costUsd.toFixed(6));
      if (result.sessionId) c.header("x-yagami-session", result.sessionId);
      return c.json(result.response);
    } catch (err) {
      const apiErr = toApiError(err);
      log?.(requestLine(apiErr.status, model, startedAt, { error: apiErr.type }));
      return c.json(apiErr.toBody(), apiErr.status as ContentfulStatusCode);
    }
  });

  app.notFound((c) =>
    c.json(errorBody("not_found_error", `no route for ${c.req.method} ${c.req.path}`), 404),
  );

  app.onError((err, c) => {
    const apiErr = toApiError(err);
    return c.json(apiErr.toBody(), apiErr.status as ContentfulStatusCode);
  });

  return app;
}
