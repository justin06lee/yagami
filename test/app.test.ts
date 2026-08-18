import { describe, expect, it } from "vitest";
import { createApp, type EngineLike } from "../src/server/app.js";
import { ApiError, type MessagesResponse } from "../src/core/types.js";

const KEY = "ygm_testkey";

const RESPONSE: MessagesResponse = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text: "pong" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 2 },
};

function fakeEngine(overrides: Partial<EngineLike> = {}): EngineLike {
  return {
    claudePath: "/fake/claude",
    complete: async () => ({ response: RESPONSE, costUsd: 0.0123, sessionId: "sess-1", ignored: ["max_tokens"] }),
    stream: () => ({
      ignored: [],
      events: (async function* () {
        yield { event: "message_start", data: { type: "message_start" } };
        yield { event: "message_stop", data: { type: "message_stop" } };
      })(),
    }),
    ...overrides,
  };
}

function post(app: ReturnType<typeof createApp>, body: unknown, key: string | null = KEY) {
  return app.request("/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

const BASIC_REQ = { model: "claude-sonnet-5", messages: [{ role: "user", content: "ping" }] };

describe("auth", () => {
  it("rejects missing and wrong keys with Anthropic-shaped 401", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    for (const key of [null, "wrong"]) {
      const res = await post(app, BASIC_REQ, key);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("authentication_error");
    }
  });

  it("accepts the key via x-api-key and via bearer token", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    expect((await post(app, BASIC_REQ)).status).toBe(200);
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(BASIC_REQ),
    });
    expect(res.status).toBe(200);
  });

  it("leaves /healthz open", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("POST /v1/messages", () => {
  it("returns the completion with yagami meta headers", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    const res = await post(app, BASIC_REQ);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESPONSE);
    expect(res.headers.get("x-yagami-cost-usd")).toBe("0.012300");
    expect(res.headers.get("x-yagami-session")).toBe("sess-1");
    expect(res.headers.get("x-yagami-ignored")).toBe("max_tokens");
    expect(res.headers.get("request-id")).toMatch(/^req_/);
  });

  it("maps ApiError from the engine to its status and body", async () => {
    const app = createApp({
      engine: fakeEngine({
        complete: async () => {
          throw new ApiError(400, "invalid_request_error", "bad thing");
        },
      }),
      apiKeys: [KEY],
    });
    const res = await post(app, BASIC_REQ);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: unknown };
    expect(body.error).toEqual({ type: "invalid_request_error", message: "bad thing" });
  });

  it("400s on invalid JSON", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("streams SSE events", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    const res = await post(app, { ...BASIC_REQ, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
    expect(text).toContain('data: {"type":"message_start"}');
  });
});

describe("misc routes", () => {
  it("serves /v1/models", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    const res = await app.request("/v1/models", { headers: { "x-api-key": KEY } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("404s unknown routes with Anthropic-shaped body", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    const res = await app.request("/v1/nothing", { headers: { "x-api-key": KEY } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("not_found_error");
  });
});
