import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Yagami } from "../src/core/client.js";
import { loadHostEngineConfig } from "../src/core/hostConfig.js";
import type { ChatCompletionChunk } from "../src/core/openai.js";
import { collect, FakeProvider } from "./helpers/fakeProvider.js";

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

  it("is skipped when explicit provider instances are passed", async () => {
    writeHostConfig({ defaultProvider: "ghost-harness" });
    const yagami = new Yagami({ providers: [new FakeProvider("fake")] });
    const response = await yagami.messages.create({ messages: [{ role: "user", content: "hi" }] });
    expect(response.content).toContainEqual({ type: "text", text: "hello" });
  });
});
