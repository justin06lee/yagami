import { describe, expect, it } from "vitest";
import { parseModelRef, qualifiedModel } from "../src/core/provider.js";
import { createProvider, detectProviders, PROVIDER_PRESETS, presetFor } from "../src/core/providers/registry.js";
import { ProviderNotInstalledError } from "../src/core/errors.js";
import { SseSynthesizer } from "../src/core/sse.js";

const IDS = ["claude", "codex", "opencode"];

describe("parseModelRef", () => {
  it("splits provider:model on a known prefix only", () => {
    expect(parseModelRef("codex:gpt-5", IDS)).toEqual({ providerId: "codex", model: "gpt-5" });
    expect(parseModelRef("opencode:anthropic/claude-sonnet-4", IDS)).toEqual({ providerId: "opencode", model: "anthropic/claude-sonnet-4" });
    expect(parseModelRef("ollama/llama3:8b", IDS)).toEqual({ model: "ollama/llama3:8b" });
    expect(parseModelRef("sonnet", IDS)).toEqual({ model: "sonnet" });
  });

  it("treats a bare provider id as its default model", () => {
    expect(parseModelRef("codex", IDS)).toEqual({ providerId: "codex" });
    expect(parseModelRef("codex:", IDS)).toEqual({ providerId: "codex" });
    expect(parseModelRef(undefined, IDS)).toEqual({});
  });

  it("round-trips through qualifiedModel", () => {
    expect(parseModelRef(qualifiedModel("codex", "gpt-5"), IDS)).toEqual({ providerId: "codex", model: "gpt-5" });
  });
});

describe("registry", () => {
  it("ships presets for the major harnesses", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    for (const id of ["claude", "codex", "opencode", "gemini", "copilot", "cursor", "qwen", "goose", "kimi"]) {
      expect(ids).toContain(id);
    }
    expect(presetFor("opencode")).toMatchObject({ kind: "acp", command: "opencode", args: ["acp"] });
    expect(presetFor("gemini")).toMatchObject({ kind: "acp", command: "gemini", args: ["--acp"] });
  });

  it("refuses unknown providers without a launch command", () => {
    expect(() => createProvider("mystery")).toThrowError(ProviderNotInstalledError);
  });

  it("reports missing executables as not installed", () => {
    expect(() => createProvider("custom-agent", { command: "definitely-not-a-real-binary-xyz", args: ["acp"] })).toThrowError(
      ProviderNotInstalledError,
    );
  });

  it("detects presets and custom entries without spawning anything", () => {
    const detected = detectProviders({ mine: { command: "definitely-not-a-real-binary-xyz" } });
    const mine = detected.find((d) => d.id === "mine");
    expect(mine).toMatchObject({ kind: "acp", installed: false });
    expect(detected.find((d) => d.id === "claude")).toMatchObject({ kind: "claude" });
  });

  it("respects enabled: false", () => {
    const detected = detectProviders({ claude: { enabled: false } });
    expect(detected.find((d) => d.id === "claude")?.installed).toBe(false);
  });
});

describe("SseSynthesizer", () => {
  it("emits an empty text block for replies with no content", () => {
    const sse = new SseSynthesizer("msg_1", "m");
    const events = [...sse.start(), ...sse.finish({ input_tokens: 1, output_tokens: 0 })].map((e) => e.event);
    expect(events).toEqual(["message_start", "content_block_start", "content_block_stop", "message_delta", "message_stop"]);
  });

  it("keeps consecutive same-kind chunks in one block and indexes blocks in order", () => {
    const sse = new SseSynthesizer("msg_1", "m");
    const events = [...sse.start(), ...sse.text("a"), ...sse.text("b"), ...sse.thinking("t"), ...sse.text("c"), ...sse.finish({ input_tokens: 1, output_tokens: 3 }, "max_tokens")];
    const starts = events.filter((e) => e.event === "content_block_start").map((e) => (e.data as { index: number }).index);
    expect(starts).toEqual([0, 1, 2]);
    const delta = events.find((e) => e.event === "message_delta")!.data as { delta: { stop_reason: string } };
    expect(delta.delta.stop_reason).toBe("max_tokens");
  });
});
