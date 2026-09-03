import { describe, expect, it, vi } from "vitest";
import { YagamiEngine } from "../src/core/engine.js";
import { SessionCache } from "../src/core/sessionCache.js";
import { ApiError } from "../src/core/types.js";
import { collect, FakeProvider, FULL_CAPS, reply } from "./helpers/fakeProvider.js";

function makeEngine(providers: FakeProvider[], defaultProvider = providers[0]!.id) {
  return new YagamiEngine({ providers, defaultProvider, sessionCache: new SessionCache() });
}

const USER = (content: string) => ({ role: "user" as const, content });
const ASSISTANT = (content: string) => ({ role: "assistant" as const, content });

describe("routing", () => {
  it("sends bare model ids to the default provider", async () => {
    const claude = new FakeProvider("claude");
    const codex = new FakeProvider("codex");
    const engine = makeEngine([claude, codex]);
    const { response } = await engine.complete({ model: "sonnet", messages: [USER("ping")] });
    expect(claude.calls[0]!.model).toBe("sonnet");
    expect(codex.calls).toHaveLength(0);
    expect(response.model).toBe("sonnet");
  });

  it("routes provider:model to that provider and reports the qualified id", async () => {
    const claude = new FakeProvider("claude");
    const codex = new FakeProvider("codex");
    const engine = makeEngine([claude, codex]);
    const result = await engine.complete({ model: "codex:gpt-5", messages: [USER("ping")] });
    expect(codex.calls[0]!.model).toBe("gpt-5");
    expect(result.provider).toBe("codex");
    expect(result.response.model).toBe("codex:gpt-5");
  });

  it("treats a bare provider id as that provider's default model", async () => {
    const claude = new FakeProvider("claude");
    const codex = new FakeProvider("codex");
    const engine = makeEngine([claude, codex]);
    const { response } = await engine.complete({ model: "codex", messages: [USER("ping")] });
    expect(codex.calls[0]!.model).toBeUndefined();
    expect(response.model).toBe("codex");
  });

  it("leaves colons alone when the prefix is not a provider", async () => {
    const claude = new FakeProvider("claude");
    const engine = makeEngine([claude]);
    await engine.complete({ model: "ollama/llama3:8b", messages: [USER("ping")] });
    expect(claude.calls[0]!.model).toBe("ollama/llama3:8b");
  });

  it("uses defaultModel (possibly qualified) when the request omits model", async () => {
    const claude = new FakeProvider("claude");
    const codex = new FakeProvider("codex");
    const engine = new YagamiEngine({ providers: [claude, codex], defaultModel: "codex:gpt-5", sessionCache: new SessionCache() });
    await engine.complete({ messages: [USER("ping")] });
    expect(codex.calls[0]!.model).toBe("gpt-5");
  });

  it("prefers the provider's model id in the response when it reports one", async () => {
    const claude = new FakeProvider("claude", FULL_CAPS, () => reply("hi", { model: "claude-sonnet-5" }));
    const engine = makeEngine([claude]);
    const { response } = await engine.complete({ model: "sonnet", messages: [USER("ping")] });
    expect(response.model).toBe("claude-sonnet-5");
  });

  it("throws when no default provider is available", () => {
    expect(() => new YagamiEngine({ providers: [], sessionCache: new SessionCache() })).toThrowError(/no supported/);
    expect(() => makeEngine([new FakeProvider("claude")], "codex")).toThrowError(/codex/);
  });
});

describe("capabilities", () => {
  const LIMITED = { ...FULL_CAPS, systemPrompt: false, thinking: false, effort: false, images: false, documents: false, fork: false };

  it("emulates system prompts by prepending them for providers without native support", async () => {
    const p = new FakeProvider("codex", LIMITED);
    const engine = makeEngine([p]);
    await engine.complete({ system: "Be terse.", messages: [USER("ping")] });
    expect(p.calls[0]!.system).toBeUndefined();
    expect(p.calls[0]!.prompt).toBe("<system>\nBe terse.\n</system>\n\nping");
  });

  it("passes system prompts natively when supported", async () => {
    const p = new FakeProvider("claude");
    const engine = makeEngine([p]);
    await engine.complete({ system: "Be terse.", messages: [USER("ping")] });
    expect(p.calls[0]!.system).toBe("Be terse.");
    expect(p.calls[0]!.prompt).toBe("ping");
  });

  it("reports unsupported thinking/effort as ignored instead of failing", async () => {
    const p = new FakeProvider("codex", LIMITED);
    const engine = makeEngine([p]);
    const { ignored } = await engine.complete({
      messages: [USER("ping")],
      thinking: { type: "enabled" },
      effort: "high",
      max_tokens: 5,
    });
    expect(ignored.sort()).toEqual(["effort", "max_tokens", "thinking"]);
    expect(p.calls[0]!.thinking).toBeUndefined();
  });

  it("still validates thinking/effort values for every provider", async () => {
    const p = new FakeProvider("codex", LIMITED);
    const engine = makeEngine([p]);
    await expect(engine.complete({ messages: [USER("x")], effort: "extreme" })).rejects.toThrowError(/effort/);
    await expect(engine.complete({ messages: [USER("x")], thinking: { type: "maybe" } })).rejects.toThrowError(/thinking/);
  });

  it("rejects media the provider cannot take", async () => {
    const p = new FakeProvider("codex", LIMITED);
    const engine = makeEngine([p]);
    await expect(
      engine.complete({
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "x" } }] }],
      }),
    ).rejects.toThrowError(/image blocks/);
  });

  it("consumes the session mapping when the provider cannot fork", async () => {
    const p = new FakeProvider("codex", LIMITED, () => reply("first", { sessionId: "t-1" }));
    const engine = makeEngine([p]);
    await engine.complete({ messages: [USER("one")] });
    const followUp = { messages: [USER("one"), ASSISTANT("first"), USER("two")] };
    p.script = () => reply("second", { sessionId: "t-1" });
    await engine.complete(followUp);
    expect(p.calls[1]!.resume).toBe("t-1");
    // A sibling branch from the same prefix must not reuse the spent session.
    await engine.complete({ messages: [USER("one"), ASSISTANT("first"), USER("other")] });
    expect(p.calls[2]!.resume).toBeUndefined();
    expect(p.calls[2]!.prompt).toContain("<conversation-history>");
  });

  it("skips resume entirely for providers without it", async () => {
    const p = new FakeProvider("gemini", { ...LIMITED, resume: false });
    const engine = makeEngine([p]);
    await engine.complete({ messages: [USER("one")] });
    await engine.complete({ messages: [USER("one"), ASSISTANT("hello"), USER("two")] });
    expect(p.calls[1]!.resume).toBeUndefined();
    expect(p.calls[1]!.prompt).toContain("User: one");
  });
});

describe("multi-turn", () => {
  it("resumes a cached session for a known conversation prefix", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => reply("first reply"));
    const engine = makeEngine([p]);
    await engine.complete({ messages: [USER("one")] });
    p.script = () => reply("second", { sessionId: "sess-2" });
    await engine.complete({ messages: [USER("one"), ASSISTANT("first reply"), USER("two")] });
    expect(p.calls[1]!.prompt).toBe("two");
    expect(p.calls[1]!.resume).toBe("sess-1");
  });

  it("flattens unknown history into a single prompt", async () => {
    const p = new FakeProvider("claude");
    const engine = makeEngine([p]);
    await engine.complete({ messages: [USER("one"), ASSISTANT("never seen"), USER("two")] });
    expect(p.calls[0]!.resume).toBeUndefined();
    expect(p.calls[0]!.prompt).toContain("Assistant: never seen");
  });

  it("retries without resume when the session is gone and drops the mapping", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => reply("first reply"));
    const engine = makeEngine([p]);
    await engine.complete({ messages: [USER("one")] });
    p.script = (req) => (req.resume ? new Error("No conversation found with session ID sess-1") : reply("recovered", { sessionId: "sess-2" }));
    const followUp = { messages: [USER("one"), ASSISTANT("first reply"), USER("two")] };
    const { response } = await engine.complete(followUp);
    expect(response.content).toEqual([{ type: "text", text: "recovered" }]);
    expect(p.calls).toHaveLength(3);
    expect(p.calls[1]!.resume).toBe("sess-1");
    expect(p.calls[2]!.resume).toBeUndefined();
    expect(p.calls[2]!.prompt).toContain("<conversation-history>");

    p.calls.length = 0;
    await engine.complete(followUp);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.resume).toBeUndefined();
  });

  it("does not retry when no resume was involved", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => new Error("boom"));
    const engine = makeEngine([p]);
    await expect(engine.complete({ messages: [USER("hi")] })).rejects.toThrowError(/boom/);
    expect(p.calls).toHaveLength(1);
  });

  it("surfaces engine failures as ApiError", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => new Error("boom"));
    const engine = makeEngine([p]);
    await expect(engine.complete({ messages: [USER("hi")] })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("prefill", () => {
  const PREFILL_REQ = { messages: [USER("answer?"), ASSISTANT("The answer is")] };

  it("appends the continuation directive and strips a repeated prefill", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => reply("The answer is 42."));
    const engine = makeEngine([p]);
    const { response } = await engine.complete(PREFILL_REQ);
    expect(p.calls[0]!.prompt).toContain("<assistant-prefill>\nThe answer is\n</assistant-prefill>");
    expect(response.content).toEqual([{ type: "text", text: " 42." }]);
  });

  it("stores the session under prefill + continuation so follow-ups resume", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => reply(" 42."));
    const engine = makeEngine([p]);
    await engine.complete(PREFILL_REQ);
    await engine.complete({ messages: [USER("answer?"), ASSISTANT("The answer is 42."), USER("thanks")] });
    expect(p.calls[1]!.resume).toBe("sess-1");
  });
});

describe("media", () => {
  const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "aaa" } };

  it("hands the last message's media to the provider", async () => {
    const p = new FakeProvider("claude");
    const engine = makeEngine([p]);
    await engine.complete({ messages: [{ role: "user", content: [IMAGE, { type: "text", text: "what?" }] }] });
    expect(p.calls[0]!.media).toEqual([IMAGE]);
    expect(p.calls[0]!.prompt).toBe("what?");
  });

  it("rejects unmatched history containing media blocks", async () => {
    const p = new FakeProvider("claude");
    const engine = makeEngine([p]);
    await expect(
      engine.complete({
        messages: [{ role: "user", content: [IMAGE, { type: "text", text: "look" }] }, ASSISTANT("nice"), USER("and now?")],
      }),
    ).rejects.toThrowError(/image\/document blocks/);
  });
});

describe("responses", () => {
  it("includes a thinking block when the provider produced thoughts", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => reply("42", { thinking: "let me think" }));
    const engine = makeEngine([p]);
    const { response } = await engine.complete({ messages: [USER("?")] });
    expect(response.content).toEqual([
      { type: "thinking", thinking: "let me think", signature: "" },
      { type: "text", text: "42" },
    ]);
    expect(response.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
  });
});

describe("streaming", () => {
  it("synthesizes a complete Anthropic SSE sequence", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => reply("hello", { chunks: ["hel", "lo"], thinking: "hm" }));
    const engine = makeEngine([p]);
    const { events } = engine.stream({ messages: [USER("ping")], stream: true });
    const all = await collect(events);
    expect(all.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const starts = all.filter((e) => e.event === "content_block_start").map((e) => (e.data as { content_block: { type: string } }).content_block.type);
    expect(starts).toEqual(["thinking", "text"]);
  });

  it("rewrites deltas so a repeated prefill never reaches the client", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => reply("", { chunks: ["The answer", " is", " 42."] }));
    const engine = makeEngine([p]);
    const { events } = engine.stream({ messages: [USER("answer?"), ASSISTANT("The answer is")], stream: true });
    const texts = (await collect(events))
      .filter((e) => e.event === "content_block_delta")
      .map((e) => (e.data as { delta: { text?: string } }).delta.text ?? "");
    expect(texts.join("")).toBe(" 42.");
  });

  it("reports cost and session via onResult", async () => {
    const p = new FakeProvider("claude");
    const engine = makeEngine([p]);
    const onResult = vi.fn();
    await collect(engine.stream({ messages: [USER("ping")], stream: true }, { onResult }).events);
    expect(onResult).toHaveBeenCalledWith({ costUsd: 0.01, sessionId: "sess-1" });
  });

  it("emits an error event when the provider fails", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => new Error("boom"));
    const engine = makeEngine([p]);
    const all = await collect(engine.stream({ messages: [USER("ping")], stream: true }).events);
    expect(all[all.length - 1]!.event).toBe("error");
  });

  it("recovers a resumed stream that dies before emitting text", async () => {
    const p = new FakeProvider("claude", FULL_CAPS, () => reply("first reply"));
    const engine = makeEngine([p]);
    await engine.complete({ messages: [USER("one")] });
    p.script = (req) => (req.resume ? new Error("No conversation found") : reply("recovered", { sessionId: "sess-2" }));
    const all = await collect(
      engine.stream({ messages: [USER("one"), ASSISTANT("first reply"), USER("two")], stream: true }).events,
    );
    expect(all.some((e) => e.event === "error")).toBe(false);
    const texts = all.filter((e) => e.event === "content_block_delta").map((e) => (e.data as { delta: { text: string } }).delta.text);
    expect(texts.join("")).toBe("recovered");
  });
});

describe("listModels", () => {
  it("aggregates providers, listing the default bare and qualified", async () => {
    const claude = new FakeProvider("claude");
    const codex = new FakeProvider("codex");
    codex.models = [{ id: "gpt-5", display_name: "GPT-5" }];
    const engine = makeEngine([claude, codex]);
    const ids = (await engine.listModels()).map((m) => m.id);
    expect(ids).toEqual(["fake-1", "claude:fake-1", "codex:gpt-5"]);
  });

  it("skips providers whose probe fails and retries them next time", async () => {
    const claude = new FakeProvider("claude");
    const codex = new FakeProvider("codex");
    codex.modelsError = new Error("down");
    const engine = makeEngine([claude, codex]);
    expect((await engine.listModels()).map((m) => m.id)).toEqual(["fake-1", "claude:fake-1"]);
    codex.modelsError = undefined;
    codex.models = [{ id: "gpt-5", display_name: "GPT-5" }];
    expect((await engine.listModels()).map((m) => m.id)).toContain("codex:gpt-5");
  });
});

describe("server tools", () => {
  const WEB_SEARCH = [{ type: "web_search_20260209", name: "web_search" }];

  it("passes resolved server tools to a provider that supports them", async () => {
    const claude = new FakeProvider("claude");
    const engine = makeEngine([claude]);
    await engine.complete({ model: "sonnet", messages: [USER("who won?")], tools: WEB_SEARCH });
    expect(claude.calls[0]!.serverTools).toEqual(["WebSearch"]);
  });

  it("leaves serverTools unset when none were requested", async () => {
    const claude = new FakeProvider("claude");
    const engine = makeEngine([claude]);
    await engine.complete({ model: "sonnet", messages: [USER("ping")] });
    expect(claude.calls[0]!.serverTools).toBeUndefined();
  });

  it("refuses rather than silently answering without the lookup", async () => {
    const codex = new FakeProvider("codex", { ...FULL_CAPS, serverTools: false });
    const engine = makeEngine([codex]);
    await expect(
      engine.complete({ model: "codex", messages: [USER("who won?")], tools: WEB_SEARCH }),
    ).rejects.toThrow(/cannot run server tools/);
    expect(codex.calls).toHaveLength(0);
  });
});
