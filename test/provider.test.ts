import { describe, expect, it } from "vitest";
import { parseModelRef, qualifiedModel } from "../src/core/provider.js";
import { createProvider, detectProviders, PROVIDER_PRESETS, presetFor } from "../src/core/providers/registry.js";
import { ClaudeProvider } from "../src/core/providers/claude.js";
import { PrintProvider } from "../src/core/providers/print.js";
import { classifyProviderFailure, ProviderError, ProviderNotInstalledError, UsageLimitError } from "../src/core/errors.js";
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

  it("launches the newer harnesses the way their own CLIs document", () => {
    // Antigravity's plan mode plans instead of answering; its default mode asks before acting
    expect(presetFor("antigravity")).toMatchObject({ kind: "acp", command: "agy", args: ["acp"], turnMode: "default" });
    expect(presetFor("grok")).toMatchObject({ kind: "acp", command: "grok", args: ["agent", "stdio"], loginCommand: "grok login" });
    expect(presetFor("kimi")).toMatchObject({ label: "Kimi Code", command: "kimi", args: ["acp"], loginCommand: "kimi login" });
    expect(presetFor("muse")).toMatchObject({ command: "muse", args: ["acp"], env: { MUSE_EXPERIMENTAL_ACP: "on" }, loginCommand: "muse login" });
    // a print mode cannot be refused a tool, so none is preset
    expect(PROVIDER_PRESETS.filter((p) => p.kind === "print")).toEqual([]);
  });

  it("holds Grok to its read-only sandbox for completion turns, not for interactive sessions", () => {
    expect(presetFor("grok")?.turnEnv).toEqual({ GROK_SANDBOX: "read-only" });
    const grok = createProvider("grok", { path: process.execPath }) as unknown as { env: NodeJS.ProcessEnv; turnEnv: NodeJS.ProcessEnv };
    expect(grok.turnEnv["GROK_SANDBOX"]).toBe("read-only");
    expect(grok.env["GROK_SANDBOX"]).toBe(process.env["GROK_SANDBOX"]);
  });

  it("keeps every preset distinct and complete", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.label, preset.id).not.toBe("");
      expect(preset.command, preset.id).not.toBe("");
      expect(preset.loginCommand, preset.id).not.toBe("");
      expect(preset.installHint, preset.id).not.toBe("");
    }
  });

  it("builds a second Claude account as its own provider", () => {
    const node = process.execPath;
    const personal = createProvider("claude-personal", { kind: "claude", path: node, configDir: "~/.claude-personal" });
    expect(personal).toBeInstanceOf(ClaudeProvider);
    expect(personal).toMatchObject({ id: "claude-personal", label: "Claude Code (claude-personal)" });
    expect(createProvider("work", { kind: "claude", path: node, label: "Work" }).label).toBe("Work");
    // a custom Claude entry looks for `claude`, not for a binary named after its id
    const detected = detectProviders({ "claude-personal": { kind: "claude", configDir: "~/.claude-personal" } });
    const claude = detected.find((d) => d.id === "claude")!;
    expect(detected.find((d) => d.id === "claude-personal")).toMatchObject({
      kind: "claude",
      label: "Claude Code (claude-personal)",
      installed: claude.installed,
      loginCommand: "claude auth login",
    });
  });

  it("builds a print-mode CLI from config alone", () => {
    const p = createProvider("mine", { kind: "print", command: process.execPath, args: ["-p", "{prompt}"], modelArgs: ["--model", "{model}"], models: ["a"] });
    expect(p).toBeInstanceOf(PrintProvider);
    expect((p as PrintProvider).buildArgs({ prompt: "hi", model: "a" })).toEqual({ args: ["-p", "hi", "--model", "a"], stdin: false });
    expect(detectProviders({ mine: { kind: "print", command: "definitely-not-a-real-binary-xyz" } }).find((d) => d.id === "mine")).toMatchObject({ kind: "print", installed: false });
  });

  it("refuses a second Codex provider instead of quietly making an ACP agent of it", () => {
    expect(() => createProvider("codex-two", { kind: "codex" })).toThrowError(/second codex provider/);
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

describe("classifyProviderFailure", () => {
  it("types a used-up plan, in any harness's words, and leaves a passing rate limit alone", () => {
    for (const said of ["You've hit your usage limit. Try again at 6pm.", "You've hit your weekly limit · resets Nov 21", "Quota exceeded for this billing period", "You are out of credits"]) {
      const err = classifyProviderFailure("codex", "codex login", new Error(said));
      expect(err, said).toBeInstanceOf(UsageLimitError);
      expect(err.message).toBe(`codex: ${said}`);
    }
    const passing = classifyProviderFailure("codex", "codex login", new Error("429 rate limit exceeded, retry in 2s"));
    expect(passing).toBeInstanceOf(ProviderError);
    expect(passing).not.toBeInstanceOf(UsageLimitError);
  });
});
