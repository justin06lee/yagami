import { describe, expect, it } from "vitest";
import {
  ChatChunkTranslator,
  chatToMessagesRequest,
  modelListBody,
  toChatCompletion,
  type ChatCompletionChunk,
} from "../src/core/openai.js";
import { SseSynthesizer } from "../src/core/sse.js";
import { ApiError, type MessagesResponse } from "../src/core/types.js";
import { createApp, type EngineLike } from "../src/server/app.js";

const KEY = "ygm_testkey";

const RESPONSE: MessagesResponse = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [
    { type: "thinking", thinking: "hmm", signature: "" },
    { type: "text", text: "pong" },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 2 },
};

describe("chatToMessagesRequest", () => {
  it("folds system/developer messages into `system` and keeps turn order", () => {
    const { req } = chatToMessagesRequest({
      model: "sonnet",
      messages: [
        { role: "system", content: "be brief" },
        { role: "developer", content: [{ type: "text", text: "and kind" }] },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "bye" },
      ],
    });
    expect(req.system).toBe("be brief\n\nand kind");
    expect(req.model).toBe("sonnet");
    expect(req.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ]);
  });

  it("converts image_url parts to Anthropic image blocks", () => {
    const { req } = chatToMessagesRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } },
            { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
          ],
        },
      ],
    });
    expect(req.messages[0]!.content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
      { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
    ]);
  });

  it("rejects tools, tool messages, and n > 1", () => {
    const user = { role: "user", content: "hi" };
    expect(() => chatToMessagesRequest({ messages: [user], tools: [{}] })).toThrowError(ApiError);
    expect(() => chatToMessagesRequest({ messages: [user], functions: [{}] })).toThrowError(ApiError);
    expect(() => chatToMessagesRequest({ messages: [user, { role: "tool", content: "x" }] })).toThrowError(ApiError);
    expect(() => chatToMessagesRequest({ messages: [user], n: 2 })).toThrowError(ApiError);
  });

  it("maps sampling params, stop, and reasoning_effort; collects unsupported params", () => {
    const { req, extraIgnored, includeUsage } = chatToMessagesRequest({
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 64,
      temperature: 0.5,
      stop: "END",
      reasoning_effort: "minimal",
      presence_penalty: 0.2,
      seed: 7,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(req.max_tokens).toBe(64);
    expect(req.temperature).toBe(0.5);
    expect(req.stop_sequences).toEqual(["END"]);
    expect(req.effort).toBe("low");
    expect(req.stream).toBe(true);
    expect(extraIgnored).toEqual(["presence_penalty", "seed"]);
    expect(includeUsage).toBe(true);
  });

  it("marks an unknown reasoning_effort as ignored instead of failing", () => {
    const { req, extraIgnored } = chatToMessagesRequest({
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "galactic",
    });
    expect(req.effort).toBeUndefined();
    expect(extraIgnored).toContain("reasoning_effort");
  });
});

describe("toChatCompletion", () => {
  it("maps text, thinking, usage, and stop reason", () => {
    const out = toChatCompletion(RESPONSE);
    expect(out.id).toBe("chatcmpl_test");
    expect(out.object).toBe("chat.completion");
    expect(out.model).toBe("claude-sonnet-5");
    expect(out.choices[0]!.message.content).toBe("pong");
    expect(out.choices[0]!.message.reasoning_content).toBe("hmm");
    expect(out.choices[0]!.finish_reason).toBe("stop");
    expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it("maps max_tokens to length", () => {
    const out = toChatCompletion({ ...RESPONSE, stop_reason: "max_tokens" });
    expect(out.choices[0]!.finish_reason).toBe("length");
  });
});

describe("ChatChunkTranslator", () => {
  function runThrough(includeUsage: boolean): unknown[] {
    const sse = new SseSynthesizer("msg_abc", "sonnet");
    const translator = new ChatChunkTranslator(includeUsage);
    const events = [
      ...sse.start(),
      ...sse.thinking("mm"),
      ...sse.text("po"),
      ...sse.text("ng"),
      ...sse.finish({ input_tokens: 5, output_tokens: 2 }),
    ];
    return events.flatMap((ev) => translator.push(ev));
  }

  it("re-emits an Anthropic SSE sequence as OpenAI chunks", () => {
    const chunks = runThrough(false) as ChatCompletionChunk[];
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: "assistant", content: "" });
    expect(chunks[0]!.id).toBe("chatcmpl_abc");
    expect(chunks[0]!.model).toBe("sonnet");
    expect(chunks[1]!.choices[0]!.delta).toEqual({ reasoning_content: "mm" });
    expect(chunks[2]!.choices[0]!.delta).toEqual({ content: "po" });
    expect(chunks[3]!.choices[0]!.delta).toEqual({ content: "ng" });
    const last = chunks[chunks.length - 1]!;
    expect(last.choices[0]!.finish_reason).toBe("stop");
  });

  it("appends a usage chunk when include_usage was requested", () => {
    const chunks = runThrough(true) as ChatCompletionChunk[];
    const last = chunks[chunks.length - 1]!;
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it("translates error events and flags them", () => {
    const translator = new ChatChunkTranslator(false);
    const out = translator.push({
      event: "error",
      data: { type: "error", error: { type: "overloaded_error", message: "busy" } },
    });
    expect(translator.errored).toBe(true);
    expect(out[0]).toEqual({ error: { message: "busy", type: "overloaded_error", param: null, code: null } });
  });
});

describe("POST /v1/chat/completions", () => {
  function fakeEngine(overrides: Partial<EngineLike> = {}): EngineLike {
    return {
      executable: "/fake/claude",
      defaultProviderId: "claude",
      providerIds: ["claude"],
      complete: async () => ({
        response: RESPONSE,
        costUsd: 0.01,
        sessionId: "sess-1",
        provider: "claude",
        ignored: ["max_tokens"],
      }),
      stream: () => {
        const sse = new SseSynthesizer("msg_abc", "sonnet");
        return {
          ignored: [],
          provider: "claude",
          events: (async function* () {
            yield* sse.start();
            yield* sse.text("pong");
            yield* sse.finish({ input_tokens: 5, output_tokens: 2 });
          })(),
        };
      },
      listModels: async () => [{ id: "sonnet", display_name: "Sonnet" }],
      ...overrides,
    };
  }

  function post(app: ReturnType<typeof createApp>, body: unknown, key: string | null = KEY) {
    return app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  const BASIC = { model: "sonnet", messages: [{ role: "user", content: "ping" }] };

  it("rejects a missing key with an OpenAI-shaped 401", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    const res = await post(app, BASIC, null);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body).not.toHaveProperty("type"); // no Anthropic top-level "error" marker
  });

  it("returns an OpenAI chat.completion with yagami meta headers", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    const res = await post(app, { ...BASIC, seed: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; choices: Array<{ message: { content: string } }> };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]!.message.content).toBe("pong");
    expect(res.headers.get("x-yagami-provider")).toBe("claude");
    expect(res.headers.get("x-yagami-ignored")).toBe("max_tokens,seed");
    expect(res.headers.get("x-yagami-cost-usd")).toBe("0.010000");
  });

  it("maps engine errors to OpenAI-shaped bodies", async () => {
    const app = createApp({
      engine: fakeEngine({
        complete: async () => {
          throw new ApiError(400, "invalid_request_error", "bad thing");
        },
      }),
      apiKeys: [KEY],
    });
    const res = await post(app, BASIC);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: "bad thing", type: "invalid_request_error", param: null, code: null },
    });
  });

  it("streams OpenAI chunks and ends with [DONE]", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    const res = await post(app, { ...BASIC, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const payloads = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));
    expect(payloads[payloads.length - 1]).toBe("[DONE]");
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p) as ChatCompletionChunk);
    expect(chunks[0]!.object).toBe("chat.completion.chunk");
    expect(chunks[0]!.choices[0]!.delta.role).toBe("assistant");
    const content = chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
    expect(content).toBe("pong");
    expect(chunks[chunks.length - 1]!.choices[0]!.finish_reason).toBe("stop");
  });

  it("serves /v1/models in the merged Anthropic+OpenAI shape", async () => {
    const app = createApp({ engine: fakeEngine(), apiKeys: [KEY] });
    const res = await app.request("/v1/models", { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      has_more: boolean;
      data: Array<{ id: string; type: string; object: string; owned_by: string; display_name: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.has_more).toBe(false);
    expect(body.data[0]).toMatchObject({
      id: "sonnet",
      type: "model",
      object: "model",
      owned_by: "yagami",
      display_name: "Sonnet",
    });
  });
});

describe("modelListBody", () => {
  it("handles an empty list without ids", () => {
    const body = modelListBody([]);
    expect(body.data).toEqual([]);
    expect(body.first_id).toBeUndefined();
  });
});
