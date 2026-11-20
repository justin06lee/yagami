import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Yagami } from "../src/core/client.js";
import { AuthRequiredError, ProviderNotInstalledError, UsageLimitError } from "../src/core/errors.js";
import { ApiError } from "../src/core/types.js";
import { loadHostEngineConfig } from "../src/core/hostConfig.js";
import { setLogSink } from "../src/core/log.js";
import type { ChatCompletionChunk } from "../src/core/openai.js";
import { collect, FakeProvider, FULL_CAPS } from "./helpers/fakeProvider.js";

function client(provider = new FakeProvider("fake")): { yagami: Yagami; provider: FakeProvider } {
  return { yagami: new Yagami({ providers: [provider], syncHostConfig: false }), provider };
}

describe("Yagami client", () => {
  it("completes with zero connection config — no URL, no API key", async () => {
    const { yagami } = client();
    const response = await yagami.messages.create({ messages: [{ role: "user", content: "hi" }] });
    expect(response.content).toContainEqual({ type: "text", text: "hello" });
    expect(response.role).toBe("assistant");
  });

  it("streams Anthropic events from messages.create({stream: true})", async () => {
    const { yagami } = client();
    const events = await collect(yagami.messages.create({ messages: [{ role: "user", content: "hi" }], stream: true }));
    expect(events[0]!.type).toBe("message_start");
    const text = events
      .filter((ev) => ev.type === "content_block_delta")
      .map((ev) => (ev["delta"] as { text?: string }).text ?? "")
      .join("");
    expect(text).toBe("hello");
    expect(events[events.length - 1]!.type).toBe("message_stop");
  });

  it("speaks the OpenAI dialect via chat.completions.create", async () => {
    const { yagami, provider } = client();
    const completion = await yagami.chat.completions.create({
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    });
    expect(completion.object).toBe("chat.completion");
    expect(completion.choices[0]!.message.content).toBe("hello");
    expect(completion.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
    expect(provider.calls[0]!.system).toBe("be brief");
  });

  it("streams OpenAI chunks from chat.completions.create({stream: true})", async () => {
    const { yagami } = client();
    const chunks: ChatCompletionChunk[] = await collect(
      yagami.chat.completions.create({ messages: [{ role: "user", content: "hi" }], stream: true }),
    );
    expect(chunks[0]!.choices[0]!.delta.role).toBe("assistant");
    const text = chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
    expect(text).toBe("hello");
    expect(chunks[chunks.length - 1]!.choices[0]!.finish_reason).toBe("stop");
  });

  it("lists models in the merged shape", async () => {
    const { yagami } = client();
    const list = await yagami.models.list();
    expect(list.object).toBe("list");
    expect(list.data[0]).toMatchObject({ id: "fake-1", type: "model", object: "model" });
  });

  it("exposes the engine for the full result (cost, session, provider)", async () => {
    const { yagami } = client();
    const result = await yagami.engine.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result.provider).toBe("fake");
    expect(result.costUsd).toBe(0.01);
  });

  it("keeps the typed failure as the ApiError's cause on every path", async () => {
    const failures = [
      new AuthRequiredError("fake", "fake login"),
      new ProviderNotInstalledError("fake", "install fake"),
    ];
    for (const failure of failures) {
      const { yagami } = client(new FakeProvider("fake", undefined, () => failure));
      const req = { messages: [{ role: "user" as const, content: "hi" }] };
      const rejections = [
        yagami.messages.create(req),
        yagami.engine.complete(req),
        yagami.chat.completions.create(req),
        collect(yagami.messages.create({ ...req, stream: true })),
        collect(yagami.chat.completions.create({ ...req, stream: true })),
      ];
      for (const rejection of rejections) {
        const err = await rejection.then(() => undefined, (e: unknown) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(503);
        expect((err as ApiError).cause).toBe(failure);
      }
    }
  });
});

describe("Yagami.turn", () => {
  const PNG = Buffer.from("png").toString("base64");

  it("runs one turn and returns the text, token counts and what the harness reported", async () => {
    const limits = [{ window: "seven_day", utilization: 0.05, resetsAt: 1795474800, status: "allowed" as const }];
    const provider = new FakeProvider("claude", FULL_CAPS, () => [
      { type: "session", sessionId: "s" },
      { type: "thinking", text: "hm" },
      { type: "text", text: "po" },
      { type: "text", text: "ng" },
      { type: "done", usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 }, costUsd: 0.01, model: "claude-x", contextWindow: 1_000_000, limits },
    ]);
    const { yagami } = client(provider);
    const seen: string[] = [];
    const result = await yagami.turn({ system: "be brief", text: "ping", images: [{ data: PNG }, { data: PNG, mediaType: "image/jpeg" }], effort: "high", onText: (d) => seen.push(d) });
    expect(result).toEqual({
      text: "pong",
      thinking: "hm",
      harness: "claude",
      model: "claude-x",
      usage: { input: 3, output: 5, cacheRead: 7, cacheWrite: 2 },
      costUsd: 0.01,
      contextWindow: 1_000_000,
      limits,
      stopReason: "end_turn",
      ignored: [],
    });
    expect(seen).toEqual(["po", "ng"]);
    expect(provider.calls[0]).toMatchObject({ prompt: "ping", system: "be brief", effort: "high" });
    expect(provider.calls[0]!.media).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG } },
    ]);
  });

  it("routes to the named harness and model, reporting the model in the harness's own id", async () => {
    const grok = new FakeProvider("grok");
    const yagami = new Yagami({ providers: [new FakeProvider("claude"), grok], syncHostConfig: false });
    const result = await yagami.turn({ harness: "grok", model: "grok-4.7", text: "hi" });
    expect(grok.calls[0]!.model).toBe("grok-4.7");
    expect(result).toMatchObject({ harness: "grok", model: "grok-4.7", text: "hello" });
    // no model named: the harness's default, under whatever name it gives
    expect((await yagami.turn({ harness: "grok", text: "hi" })).model).toBe("grok");
    expect(grok.calls[1]!.model).toBeUndefined();
  });

  it("searches the web where the harness can, and says so where it cannot", async () => {
    const claude = new FakeProvider("claude");
    const grok = new FakeProvider("grok", { ...FULL_CAPS, serverTools: false, effort: false });
    const yagami = new Yagami({ providers: [claude, grok], syncHostConfig: false });
    expect((await yagami.turn({ text: "news?", webSearch: true })).ignored).toEqual([]);
    expect(claude.calls[0]!.serverTools).toEqual(["WebSearch"]);
    const without = await yagami.turn({ harness: "grok", text: "news?", webSearch: true, effort: "high" });
    expect(without.ignored).toEqual(["effort", "webSearch"]);
    expect(grok.calls[0]!.serverTools).toBeUndefined();
  });

  it("rejects with the typed failure itself", async () => {
    const usedUp = new UsageLimitError("claude", 1795251600, "You've hit your weekly limit");
    for (const failure of [usedUp, new AuthRequiredError("claude", "claude auth login")]) {
      const { yagami } = client(new FakeProvider("claude", undefined, () => failure));
      await expect(yagami.turn({ text: "hi" })).rejects.toBe(failure);
    }
    // a harness that is not there is a failure, never a turn on some other harness
    const { yagami, provider } = client();
    await expect(yagami.turn({ harness: "muse", text: "hi" })).rejects.toBeInstanceOf(ProviderNotInstalledError);
    expect(provider.calls).toEqual([]);
    // a request the harness cannot take stays an ApiError
    const blind = client(new FakeProvider("fake", { ...FULL_CAPS, images: false }));
    await expect(blind.yagami.turn({ text: "what is this?", images: [{ data: PNG }] })).rejects.toMatchObject({ status: 400 });
  });

  it("ends as an AbortError when the caller aborts", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider("fake", FULL_CAPS, () => [
      { type: "text", text: "first" },
      { type: "text", text: "never" },
      { type: "done", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const { yagami } = client(provider);
    const seen: string[] = [];
    const turn = yagami.turn({ text: "hi", signal: controller.signal, onText: (d) => (seen.push(d), controller.abort()) });
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual(["first"]);
    expect(provider.calls[0]!.signal).toBe(controller.signal);
  });
});

describe("Yagami harnesses, models and limits", () => {
  it("hands a host the list, a harness's models, and its plan usage", async () => {
    const provider = new FakeProvider("claude");
    provider.signIn = { signedIn: true };
    provider.plan = { plan: "max", windows: [{ window: "five_hour", utilization: 0.4 }] };
    provider.models = [{ id: "a", display_name: "A" }, { id: "b", display_name: "B", is_default: true }];
    const { yagami } = client(provider);
    expect((await yagami.harnesses()).find((h) => h.id === "claude")).toMatchObject({ signedIn: true, available: true, isDefault: true });
    expect((await yagami.models.for("claude")).map((m) => m.id)).toEqual(["b", "a"]);
    expect(await yagami.limits()).toEqual(provider.plan);
    expect(await yagami.limits("claude")).toEqual(provider.plan);
  });
});

describe("host config sync", () => {
  const savedDir = process.env["YAGAMI_CONFIG_DIR"];

  afterEach(() => {
    if (savedDir === undefined) delete process.env["YAGAMI_CONFIG_DIR"];
    else process.env["YAGAMI_CONFIG_DIR"] = savedDir;
  });

  function writeHostConfig(config: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-test-"));
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
    process.env["YAGAMI_CONFIG_DIR"] = dir;
    return dir;
  }

  it("reads the binary's config so library and server agree", () => {
    writeHostConfig({
      host: "127.0.0.1",
      port: 9999,
      apiKeys: ["ygm_serveronly"],
      defaultProvider: "codex",
      defaultModel: "gpt-5",
      providers: { codex: { sandbox: "read-only" } },
    });
    const host = loadHostEngineConfig();
    expect(host.defaultProvider).toBe("codex");
    expect(host.defaultModel).toBe("gpt-5");
    expect(host.providerConfig).toEqual({ codex: { sandbox: "read-only" } });
    // Server-only fields never leak into library mode.
    expect(host).not.toHaveProperty("apiKeys");
    expect(host).not.toHaveProperty("port");
  });

  it("returns nothing when no config exists (pure auto-detect)", () => {
    process.env["YAGAMI_CONFIG_DIR"] = path.join(os.tmpdir(), "yagami-test-does-not-exist");
    expect(loadHostEngineConfig()).toEqual({});
  });

  it("warns about a corrupt config instead of silently ignoring it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-test-"));
    fs.writeFileSync(path.join(dir, "config.json"), "{ nope");
    process.env["YAGAMI_CONFIG_DIR"] = dir;
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      expect(loadHostEngineConfig()).toEqual({});
    } finally {
      setLogSink(null);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/config: ignoring .*config\.json: not valid JSON/);
  });

  it("is skipped when explicit provider instances are passed", async () => {
    writeHostConfig({ defaultProvider: "ghost-harness" });
    const yagami = new Yagami({ providers: [new FakeProvider("fake")] });
    const response = await yagami.messages.create({ messages: [{ role: "user", content: "hi" }] });
    expect(response.content).toContainEqual({ type: "text", text: "hello" });
  });
});
