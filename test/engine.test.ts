import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCache } from "../src/core/sessionCache.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { YagamiEngine } from "../src/core/engine.js";

/** A fake `claude` binary path: any real file satisfies the resolver. */
const FAKE_CLAUDE = process.execPath;

interface RunOptions {
  sessionId?: string;
  text?: string;
  deltas?: string[];
  model?: string;
}

/** One successful non-streaming SDK run. */
async function* sdkComplete({ sessionId = "sess-1", text = "hello", model = "claude-x" }: RunOptions = {}) {
  yield { type: "system", subtype: "init", session_id: sessionId };
  yield {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: "msg_raw",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    },
  };
  yield {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    result: text,
    usage: { input_tokens: 3, output_tokens: 5 },
    total_cost_usd: 0.01,
  };
}

/** One successful streaming SDK run emitting partial-message events. */
async function* sdkStream({ sessionId = "sess-1", deltas = ["hel", "lo"], model = "claude-x" }: RunOptions = {}) {
  yield { type: "system", subtype: "init", session_id: sessionId };
  const ev = (event: Record<string, unknown>) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    event,
  });
  yield ev({ type: "message_start", message: { id: "msg_raw", model } });
  yield ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const text of deltas) {
    yield ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  }
  yield ev({ type: "content_block_stop", index: 0 });
  yield ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
  yield ev({ type: "message_stop" });
  yield {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    result: deltas.join(""),
    usage: { input_tokens: 3, output_tokens: 5 },
    total_cost_usd: 0.01,
  };
}

function makeEngine(): YagamiEngine {
  return new YagamiEngine({
    claudePath: FAKE_CLAUDE,
    defaultModel: "claude-x",
    sessionCache: new SessionCache(),
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

beforeEach(() => {
  queryMock.mockReset();
});

describe("YagamiEngine.complete", () => {
  it("sends the last user text as the prompt for single-turn requests", async () => {
    queryMock.mockImplementation(() => sdkComplete());
    const engine = makeEngine();
    const { response, costUsd, sessionId } = await engine.complete({
      model: "claude-x",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(queryMock).toHaveBeenCalledOnce();
    expect(queryMock.mock.calls[0]![0].prompt).toBe("ping");
    expect(response.content).toEqual([{ type: "text", text: "hello" }]);
    expect(costUsd).toBe(0.01);
    expect(sessionId).toBe("sess-1");
  });

  it("resumes a cached session for a known conversation prefix", async () => {
    queryMock.mockImplementation(() => sdkComplete({ text: "first reply" }));
    const engine = makeEngine();
    await engine.complete({ model: "claude-x", messages: [{ role: "user", content: "one" }] });

    queryMock.mockImplementation(() => sdkComplete({ text: "second reply", sessionId: "sess-2" }));
    await engine.complete({
      model: "claude-x",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "first reply" },
        { role: "user", content: "two" },
      ],
    });
    const second = queryMock.mock.calls[1]![0];
    expect(second.prompt).toBe("two");
    expect(second.options.resume).toBe("sess-1");
    expect(second.options.forkSession).toBe(true);
  });

  it("flattens unknown history into a single prompt", async () => {
    queryMock.mockImplementation(() => sdkComplete());
    const engine = makeEngine();
    await engine.complete({
      model: "claude-x",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "never seen" },
        { role: "user", content: "two" },
      ],
    });
    const { prompt, options } = queryMock.mock.calls[0]![0];
    expect(options.resume).toBeUndefined();
    expect(prompt).toContain("<conversation-history>");
    expect(prompt).toContain("Assistant: never seen");
  });
});

describe("YagamiEngine.complete with prefill", () => {
  const PREFILL_REQ = {
    model: "claude-x",
    messages: [
      { role: "user" as const, content: "answer?" },
      { role: "assistant" as const, content: "The answer is" },
    ],
  };

  it("appends the continuation directive to the prompt", async () => {
    queryMock.mockImplementation(() => sdkComplete({ text: " 42." }));
    const engine = makeEngine();
    await engine.complete(PREFILL_REQ);
    const { prompt } = queryMock.mock.calls[0]![0];
    expect(prompt).toContain("answer?");
    expect(prompt).toContain("<assistant-prefill>\nThe answer is\n</assistant-prefill>");
  });

  it("strips a repeated prefill from the response content", async () => {
    queryMock.mockImplementation(() => sdkComplete({ text: "The answer is 42." }));
    const engine = makeEngine();
    const { response } = await engine.complete(PREFILL_REQ);
    expect(response.content).toEqual([{ type: "text", text: " 42." }]);
  });

  it("stores the session under prefill + continuation so follow-ups resume", async () => {
    queryMock.mockImplementation(() => sdkComplete({ text: " 42." }));
    const engine = makeEngine();
    await engine.complete(PREFILL_REQ);

    queryMock.mockImplementation(() => sdkComplete({ text: "done", sessionId: "sess-2" }));
    await engine.complete({
      model: "claude-x",
      messages: [
        { role: "user", content: "answer?" },
        { role: "assistant", content: "The answer is 42." },
        { role: "user", content: "thanks" },
      ],
    });
    expect(queryMock.mock.calls[1]![0].options.resume).toBe("sess-1");
  });
});

describe("YagamiEngine.listModels", () => {
  it("probes the CLI once and caches the result", async () => {
    queryMock.mockImplementation(() => ({
      supportedModels: async () => [
        { value: "sonnet", displayName: "Sonnet", description: "fast", resolvedModel: "claude-sonnet-5" },
      ],
    }));
    const engine = makeEngine();
    const models = await engine.listModels();
    expect(models).toEqual([
      { id: "sonnet", display_name: "Sonnet", description: "fast", resolved_model: "claude-sonnet-5" },
    ]);
    await engine.listModels();
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it("does not cache a failed probe", async () => {
    queryMock.mockImplementation(() => ({
      supportedModels: async () => {
        throw new Error("engine down");
      },
    }));
    const engine = makeEngine();
    await expect(engine.listModels()).rejects.toThrowError(/engine down/);
    await expect(engine.listModels()).rejects.toThrowError(/engine down/);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe("YagamiEngine resume fallback", () => {
  const FOLLOW_UP = {
    model: "claude-x",
    messages: [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "first reply" },
      { role: "user" as const, content: "two" },
    ],
  };

  /** Seed the cache so FOLLOW_UP's prefix maps to sess-1, then make any
   *  resumed attempt die the way a garbage-collected session does. */
  async function seedThenBreakResume(engine: YagamiEngine, text = "ok") {
    queryMock.mockImplementation(() => sdkComplete({ text: "first reply" }));
    await engine.complete({ model: "claude-x", messages: [{ role: "user", content: "one" }] });
    queryMock.mockImplementation(({ options }: { options: { resume?: string } }) => {
      if (options.resume) throw new Error("No conversation found with session ID sess-1");
      return sdkComplete({ text, sessionId: "sess-2" });
    });
  }

  it("retries complete() without resume when the session is gone", async () => {
    const engine = makeEngine();
    await seedThenBreakResume(engine, "recovered");
    const { response } = await engine.complete(FOLLOW_UP);
    expect(response.content).toEqual([{ type: "text", text: "recovered" }]);
    const attempts = queryMock.mock.calls.slice(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]![0].options.resume).toBe("sess-1");
    expect(attempts[1]![0].options.resume).toBeUndefined();
    expect(attempts[1]![0].prompt).toContain("<conversation-history>");
  });

  it("drops the stale cache entry so the next request replays directly", async () => {
    const engine = makeEngine();
    await seedThenBreakResume(engine);
    await engine.complete(FOLLOW_UP);
    queryMock.mockClear();
    queryMock.mockImplementation(() => sdkComplete({ text: "again", sessionId: "sess-3" }));
    await engine.complete(FOLLOW_UP);
    expect(queryMock).toHaveBeenCalledOnce();
    expect(queryMock.mock.calls[0]![0].options.resume).toBeUndefined();
  });

  it("does not retry when no resume was involved", async () => {
    queryMock.mockImplementation(async function* () {
      throw new Error("boom");
    });
    const engine = makeEngine();
    await expect(
      engine.complete({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrowError(/boom/);
    expect(queryMock).toHaveBeenCalledOnce();
  });

  it("recovers a stream that dies before emitting events", async () => {
    const engine = makeEngine();
    queryMock.mockImplementation(() => sdkComplete({ text: "first reply" }));
    await engine.complete({ model: "claude-x", messages: [{ role: "user", content: "one" }] });

    queryMock.mockImplementation(({ options }: { options: { resume?: string } }) => {
      if (options.resume) throw new Error("No conversation found with session ID sess-1");
      return sdkStream({ deltas: ["recovered"], sessionId: "sess-2" });
    });
    const { events } = engine.stream({ ...FOLLOW_UP, stream: true });
    const all = await collect(events);
    expect(all.some((e) => e.event === "error")).toBe(false);
    const texts = all
      .filter((e) => e.event === "content_block_delta")
      .map((e) => (e.data as { delta: { text: string } }).delta.text);
    expect(texts.join("")).toBe("recovered");
  });
});

describe("YagamiEngine.complete with media blocks", () => {
  const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "aaa" } };

  it("sends media via streaming input with the text appended last", async () => {
    queryMock.mockImplementation(() => sdkComplete());
    const engine = makeEngine();
    await engine.complete({
      model: "claude-x",
      messages: [{ role: "user", content: [IMAGE, { type: "text", text: "what is this?" }] }],
    });
    const { prompt } = queryMock.mock.calls[0]![0];
    expect(typeof prompt).not.toBe("string");
    const yielded = [];
    for await (const m of prompt) yielded.push(m);
    expect(yielded).toHaveLength(1);
    expect(yielded[0].message).toEqual({
      role: "user",
      content: [IMAGE, { type: "text", text: "what is this?" }],
    });
    expect(yielded[0].parent_tool_use_id).toBeNull();
  });

  it("rejects unmatched history containing media blocks", async () => {
    queryMock.mockImplementation(() => sdkComplete());
    const engine = makeEngine();
    await expect(
      engine.complete({
        model: "claude-x",
        messages: [
          { role: "user", content: [IMAGE, { type: "text", text: "look" }] },
          { role: "assistant", content: "nice pic" },
          { role: "user", content: "and now?" },
        ],
      }),
    ).rejects.toThrowError(/image\/document blocks/);
  });

  it("resumes past media history when the session is cached", async () => {
    queryMock.mockImplementation(() => sdkComplete({ text: "nice pic" }));
    const engine = makeEngine();
    await engine.complete({
      model: "claude-x",
      messages: [{ role: "user", content: [IMAGE, { type: "text", text: "look" }] }],
    });

    queryMock.mockImplementation(() => sdkComplete({ text: "sure", sessionId: "sess-2" }));
    await engine.complete({
      model: "claude-x",
      messages: [
        { role: "user", content: [IMAGE, { type: "text", text: "look" }] },
        { role: "assistant", content: "nice pic" },
        { role: "user", content: "and now?" },
      ],
    });
    const second = queryMock.mock.calls[1]![0];
    expect(second.options.resume).toBe("sess-1");
    expect(second.prompt).toBe("and now?");
  });
});

describe("YagamiEngine.stream", () => {
  it("passes raw stream events through", async () => {
    queryMock.mockImplementation(() => sdkStream());
    const engine = makeEngine();
    const { events } = engine.stream({
      model: "claude-x",
      messages: [{ role: "user", content: "ping" }],
      stream: true,
    });
    const all = await collect(events);
    expect(all.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("rewrites deltas so a repeated prefill never reaches the client", async () => {
    queryMock.mockImplementation(() => sdkStream({ deltas: ["The answer", " is", " 42."] }));
    const engine = makeEngine();
    const { events } = engine.stream({
      model: "claude-x",
      messages: [
        { role: "user", content: "answer?" },
        { role: "assistant", content: "The answer is" },
      ],
      stream: true,
    });
    const all = await collect(events);
    const texts = all
      .filter((e) => e.event === "content_block_delta")
      .map((e) => (e.data as { delta: { text: string } }).delta.text);
    expect(texts.join("")).toBe(" 42.");
  });

  it("reports cost and session via onResult when the stream completes", async () => {
    queryMock.mockImplementation(() => sdkStream());
    const engine = makeEngine();
    const onResult = vi.fn();
    const { events } = engine.stream(
      { model: "claude-x", messages: [{ role: "user", content: "ping" }], stream: true },
      { onResult },
    );
    await collect(events);
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith({ costUsd: 0.01, sessionId: "sess-1" });
  });

  it("emits an error event when the engine fails mid-stream", async () => {
    queryMock.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      throw new Error("boom");
    });
    const engine = makeEngine();
    const { events } = engine.stream({
      model: "claude-x",
      messages: [{ role: "user", content: "ping" }],
      stream: true,
    });
    const all = await collect(events);
    expect(all[all.length - 1]!.event).toBe("error");
  });
});
