import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError, type MessagesRequest } from "../core/types.js";
import type { CompleteResult, EngineModel, StreamStart } from "../core/engine.js";

/** What the app needs from an engine — lets tests inject a fake. */
export interface EngineLike {
  claudePath: string;
  complete(req: MessagesRequest): Promise<CompleteResult>;
  stream(req: MessagesRequest, opts?: { signal?: AbortSignal }): StreamStart;
  listModels(): Promise<EngineModel[]>;
}

export interface AppOptions {
  engine: EngineLike;
  apiKeys: string[];
  cors?: boolean;
  version?: string;
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

export function createApp(options: AppOptions): Hono {
  const { engine, apiKeys } = options;
  const app = new Hono();

  if (options.cors) app.use("*", cors());

  app.use("*", async (c, next) => {
    c.header("request-id", `req_${randomUUID().replace(/-/g, "")}`);
    await next();
  });

  app.get("/healthz", (c) =>
    c.json({ ok: true, service: "yagami", version: options.version, claude: engine.claudePath }),
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

    try {
      if (req.stream === true) {
        const abortController = new AbortController();
        const { ignored, events } = engine.stream(req, { signal: abortController.signal });
        if (ignored.length > 0) c.header("x-yagami-ignored", ignored.join(","));
        return streamSSE(c, async (stream) => {
          stream.onAbort(() => abortController.abort());
          for await (const ev of events) {
            await stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) });
          }
        });
      }

      const result = await engine.complete(req);
      if (result.ignored.length > 0) c.header("x-yagami-ignored", result.ignored.join(","));
      if (result.costUsd !== undefined) c.header("x-yagami-cost-usd", result.costUsd.toFixed(6));
      if (result.sessionId) c.header("x-yagami-session", result.sessionId);
      return c.json(result.response);
    } catch (err) {
      if (err instanceof ApiError) {
        return c.json(err.toBody(), err.status as ContentfulStatusCode);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json(errorBody("api_error", message), 500);
    }
  });

  app.notFound((c) =>
    c.json(errorBody("not_found_error", `no route for ${c.req.method} ${c.req.path}`), 404),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as ContentfulStatusCode);
    return c.json(errorBody("api_error", err.message), 500);
  });

  return app;
}
