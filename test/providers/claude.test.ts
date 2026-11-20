import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeProvider, planLimits } from "../../src/core/providers/claude.js";
import { AuthRequiredError, UsageLimitError } from "../../src/core/errors.js";
import { collect } from "../helpers/fakeProvider.js";

const FAKE_CLAUDE = process.execPath;

async function* sdkRun({ text = "hello", deltas, sessionId = "sess-1", model = "claude-x", thinking, modelUsage }: {
  modelUsage?: Record<string, { contextWindow: number }>;
  text?: string;
  deltas?: string[];
  sessionId?: string;
  model?: string;
  thinking?: string;
} = {}) {
  yield { type: "system", subtype: "init", session_id: sessionId };
  const ev = (event: Record<string, unknown>) => ({ type: "stream_event", parent_tool_use_id: null, event });
  if (thinking) yield ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } });
  for (const t of deltas ?? [text]) {
    if (t) yield ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: t } });
  }
  yield { type: "assistant", parent_tool_use_id: null, message: { id: "msg_raw", model, content: [], stop_reason: "end_turn" } };
  yield {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    result: (deltas ?? [text]).join(""),
    usage: { input_tokens: 3, output_tokens: 5 },
    total_cost_usd: 0.01,
    modelUsage,
  };
}

beforeEach(() => queryMock.mockReset());

describe("ClaudeProvider.run", () => {
  it("rejects CLI error results even when their subtype is success", async () => {
    queryMock.mockImplementation(async function* () {
      yield { type: "result", subtype: "success", is_error: true, result: "1M context unavailable", modelUsage: {}, usage: {} };
    });
    await expect(collect(new ClaudeProvider({ path: FAKE_CLAUDE }).run({ prompt: "ping", model: "opus" }))).rejects.toThrow(/1M context unavailable/);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
  it("rejects an observed long-context downgrade without retrying", async () => {
    queryMock.mockImplementation(() => sdkRun({ model: "claude-haiku-99", modelUsage: { "claude-haiku-99": { contextWindow: 200_000 } } }));
    await expect(collect(new ClaudeProvider({ path: FAKE_CLAUDE }).run({ prompt: "ping", model: "haiku" }))).rejects.toThrow(/requested.*1M.*200000/i);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]![0].options.model).toBe("haiku[1m]");
  });
  it("propagates unavailable 1M errors without retrying a shorter model", async () => {
    queryMock.mockImplementation(async function* () { throw new Error("1M context is unavailable for this account"); });
    await expect(collect(new ClaudeProvider({ path: FAKE_CLAUDE }).run({ prompt: "ping", model: "opus" }))).rejects.toThrow(/unavailable/);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
  it("reports observed primary context and annotates the live catalog from modelUsage", async () => {
    const p = new ClaudeProvider({ path: FAKE_CLAUDE });
    queryMock.mockImplementation(() => sdkRun({ model: "claude-sonnet-99", modelUsage: {
      "claude-haiku-99": { contextWindow: 200_000 },
      "claude-sonnet-99": { contextWindow: 1_000_000 },
    } }));
    const events = await collect(p.run({ prompt: "ping", model: "sonnet" }));
    expect(events.at(-1)).toMatchObject({ type: "done", model: "claude-sonnet-99", contextWindow: 1_000_000 });
    queryMock.mockImplementation(() => ({ supportedModels: async () => [
      { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-99" },
    ] }));
    expect((await p.listModels())[0]).toMatchObject({ context_window: 1_000_000, context_window_source: "observed" });
  });
  it("requests 1M on the dynamic default when model is omitted", async () => {
    queryMock.mockImplementation(() => sdkRun());
    await collect(new ClaudeProvider({ path: FAKE_CLAUDE }).run({ prompt: "ping" }));
    expect(queryMock.mock.calls[0]![0].options.model).toBe("sonnet[1m]");
  });
  it("requests long context without pinning the live alias", async () => {
    queryMock.mockImplementation(() => sdkRun());
    await collect(new ClaudeProvider({ path: FAKE_CLAUDE }).run({ prompt: "ping", model: "sonnet" }));
    expect(queryMock.mock.calls[0]![0].options.model).toBe("sonnet[1m]");
  });
  it("maps SDK messages onto turn events", async () => {
    queryMock.mockImplementation(() => sdkRun({ deltas: ["hel", "lo"], thinking: "hm" }));
    const p = new ClaudeProvider({ path: FAKE_CLAUDE });
    const events = await collect(p.run({ prompt: "ping", model: "claude-x" }));
    expect(events).toEqual([
      { type: "session", sessionId: "sess-1" },
      { type: "thinking", text: "hm" },
      { type: "text", text: "hel" },
      { type: "text", text: "lo" },
      {
        type: "done",
        usage: { input_tokens: 3, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        costUsd: 0.01,
        model: "claude-x",
        stopReason: "end_turn",
      },
    ]);
    const { prompt, options } = queryMock.mock.calls[0]![0];
    expect(prompt).toBe("ping");
    expect(options.model).toBe("claude-x");
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.skills).toEqual([]);
    expect(options.maxTurns).toBe(1);
    expect(options.includePartialMessages).toBe(true);
  });

  it("falls back to the final result text when no deltas were streamed", async () => {
    queryMock.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s" };
      yield { type: "result", subtype: "success", session_id: "s", result: "whole", usage: {}, total_cost_usd: 0 };
    });
    const p = new ClaudeProvider({ path: FAKE_CLAUDE });
    const events = await collect(p.run({ prompt: "ping" }));
    expect(events.find((e) => e.type === "text")).toEqual({ type: "text", text: "whole" });
  });

  it("resumes with forkSession and passes system/thinking/effort through", async () => {
    queryMock.mockImplementation(() => sdkRun());
    const p = new ClaudeProvider({ path: FAKE_CLAUDE });
    await collect(p.run({ prompt: "two", resume: "sess-1", system: "sys", thinking: { type: "enabled", budget_tokens: 10 }, effort: "high" }));
    const { options } = queryMock.mock.calls[0]![0];
    expect(options.resume).toBe("sess-1");
    expect(options.forkSession).toBe(true);
    expect(options.systemPrompt).toBe("sys");
    expect(options.thinking).toEqual({ type: "enabled", budgetTokens: 10 });
    expect(options.effort).toBe("high");
  });

  it("sends media via streaming input with the text appended last", async () => {
    queryMock.mockImplementation(() => sdkRun());
    const p = new ClaudeProvider({ path: FAKE_CLAUDE });
    const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "aaa" } };
    await collect(p.run({ prompt: "what?", media: [IMAGE] }));
    const { prompt } = queryMock.mock.calls[0]![0];
    const yielded = [];
    for await (const m of prompt) yielded.push(m);
    expect(yielded[0].message).toEqual({ role: "user", content: [IMAGE, { type: "text", text: "what?" }] });
  });

  it("classifies sign-in problems as AuthRequiredError", async () => {
    queryMock.mockImplementation(async function* () {
      throw new Error("Not logged in · Please run /login");
    });
    const p = new ClaudeProvider({ path: FAKE_CLAUDE });
    await expect(collect(p.run({ prompt: "ping" }))).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("turns engine error results into provider errors", async () => {
    queryMock.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s" };
      yield { type: "result", subtype: "error_during_execution", session_id: "s", errors: ["kaboom"] };
    });
    const p = new ClaudeProvider({ path: FAKE_CLAUDE });
    await expect(collect(p.run({ prompt: "ping" }))).rejects.toThrowError(/kaboom/);
  });
});

describe("ClaudeProvider plan limits", () => {
  const WEEK = { status: "allowed", resetsAt: 1795474800, rateLimitType: "seven_day", unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1795000000, status: "allowed_warning" }, seven_day: { utilization: 0.05, resetsAt: 1795474800, status: "allowed" } } };

  it("reads every window a rate-limit event lists, or the one an older CLI reports", () => {
    expect(planLimits(WEEK)).toEqual([
      { window: "five_hour", utilization: 0.4, resetsAt: 1795000000, status: "warning" },
      { window: "seven_day", utilization: 0.05, resetsAt: 1795474800, status: "allowed" },
    ]);
    expect(planLimits({ status: "rejected", resetsAt: 5, rateLimitType: "five_hour", utilization: 1 })).toEqual([
      { window: "five_hour", utilization: 1, resetsAt: 5, status: "rejected" },
    ]);
    expect(planLimits({})).toEqual([]);
  });

  it("reports the plan's windows with the finished turn", async () => {
    queryMock.mockImplementation(async function* () {
      yield { type: "rate_limit_event", rate_limit_info: WEEK };
      yield* sdkRun();
    });
    const events = await collect(new ClaudeProvider({ path: FAKE_CLAUDE }).run({ prompt: "ping" }));
    expect(events.at(-1)).toMatchObject({ type: "done", limits: planLimits(WEEK) });
  });

  it("fails a used-up plan as UsageLimitError with its reset time", async () => {
    const rejected = { status: "rejected", resetsAt: 1795251600, rateLimitType: "seven_day", unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1795251600, status: "rejected" } } };
    // what the CLI does: the event, an error result, then the SDK throws
    queryMock.mockImplementation(async function* () {
      yield { type: "system", subtype: "init", session_id: "s" };
      yield { type: "rate_limit_event", rate_limit_info: rejected };
      yield { type: "result", subtype: "success", is_error: true, result: "You've hit your weekly limit · resets Nov 21 at 6pm", usage: {}, api_error_status: 429 };
      throw new Error("Claude Code returned an error result: You've hit your weekly limit · resets Nov 21 at 6pm");
    });
    const err = await collect(new ClaudeProvider({ path: FAKE_CLAUDE, id: "claude-work" }).run({ prompt: "ping" })).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(UsageLimitError);
    expect(err).toMatchObject({ provider: "claude-work", resetsAt: 1795251600, code: "usage_limit" });
    expect((err as Error).message).toBe("claude-work: You've hit your weekly limit · resets Nov 21 at 6pm");

    // an older CLI that sends no event still says so in words
    queryMock.mockImplementation(async function* () {
      throw new Error("Claude AI usage limit reached");
    });
    const wordy = await collect(new ClaudeProvider({ path: FAKE_CLAUDE }).run({ prompt: "ping" })).then(() => undefined, (e: unknown) => e);
    expect(wordy).toBeInstanceOf(UsageLimitError);
    expect((wordy as UsageLimitError).resetsAt).toBeUndefined();
  });

  it("reads plan usage over a control session, as shares of each window", async () => {
    const closed = vi.fn();
    queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) => {
      options.abortController.signal.addEventListener("abort", closed);
      return {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          subscription_type: "max",
          rate_limits: {
            five_hour: null,
            seven_day: { utilization: 100, resets_at: "2026-11-21T09:00:00.030028+00:00" },
            extra_usage: { is_enabled: false, utilization: null },
            limits: [{ kind: "weekly_all", percent: 100 }],
          },
        }),
      };
    });
    expect(await new ClaudeProvider({ path: FAKE_CLAUDE }).limits()).toEqual({
      plan: "max",
      windows: [{ window: "seven_day", utilization: 1, resetsAt: 1795251600, status: "rejected" }],
    });
    expect(closed).toHaveBeenCalled();

    // a CLI too old to be asked
    queryMock.mockImplementation(() => ({}));
    expect(await new ClaudeProvider({ path: FAKE_CLAUDE }).limits()).toBeUndefined();
  });
});

describe("ClaudeProvider accounts", () => {
  const envOf = async (options: ConstructorParameters<typeof ClaudeProvider>[0]) => {
    queryMock.mockImplementation(() => sdkRun());
    await collect(new ClaudeProvider({ path: FAKE_CLAUDE, ...options }).run({ prompt: "ping" }));
    return queryMock.mock.calls.at(-1)![0].options.env as NodeJS.ProcessEnv;
  };

  it("selects an account by its config directory, the default one by leaving the variable out", async () => {
    const before = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = "/somewhere/else";
    try {
      // no choice made: the CLI runs as the host process would run it
      expect((await envOf({})).CLAUDE_CONFIG_DIR).toBe("/somewhere/else");
      expect((await envOf({ configDir: "~/.claude-personal" })).CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), ".claude-personal"));
      // naming ~/.claude outright reads as a different, signed-out account
      expect("CLAUDE_CONFIG_DIR" in (await envOf({ configDir: "~/.claude" }))).toBe(false);
    } finally {
      if (before === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = before;
    }
  });

  it("is its own provider under its own id, with a login command for that account", () => {
    const personal = new ClaudeProvider({ path: FAKE_CLAUDE, id: "claude-personal", label: "Claude Code (personal)", configDir: "~/.claude-personal" });
    expect(personal).toMatchObject({ id: "claude-personal", label: "Claude Code (personal)" });
    expect(personal.loginCommand).toBe(`CLAUDE_CONFIG_DIR=${path.join(os.homedir(), ".claude-personal")} claude auth login`);
    expect(new ClaudeProvider({ path: FAKE_CLAUDE, configDir: "~/.claude" }).loginCommand).toBe("claude auth login");
  });
});

describe("ClaudeProvider.status", () => {
  /** A stand-in `claude` that answers `auth status --json` with `body`. */
  const fakeCli = (body: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-claude-"));
    const file = path.join(dir, "claude");
    fs.writeFileSync(file, `#!/bin/sh\n[ "$1 $2 $3" = "auth status --json" ] || exit 9\ncat <<EOF\n${body}\nEOF\n`, { mode: 0o755 });
    return file;
  };

  it("asks the CLI whether the account is signed in", async () => {
    const signedIn = new ClaudeProvider({ path: fakeCli('{"loggedIn": true, "email": "me@example.com", "subscriptionType": "max"}') });
    expect(await signedIn.status()).toEqual({ signedIn: true, account: "me@example.com", plan: "max" });
    expect(await new ClaudeProvider({ path: fakeCli('{"loggedIn": false, "authMethod": "none"}') }).status()).toEqual({ signedIn: false });
  });

  it("asks about the account it was given", async () => {
    const p = new ClaudeProvider({ path: fakeCli('{"loggedIn": true, "email": "$CLAUDE_CONFIG_DIR"}'), configDir: "/tmp/other-account" });
    expect(await p.status()).toMatchObject({ signedIn: true, account: "/tmp/other-account" });
  });

  it("cannot tell with a CLI that has no such command", async () => {
    const status = await new ClaudeProvider({ path: fakeCli("error: unknown command 'auth'") }).status();
    expect(status.signedIn).toBeUndefined();
    expect(status.detail).toMatch(/unknown command/);
  });
});

describe("ClaudeProvider.listModels", () => {
  it("reports Yagami's safe dynamic Sonnet default instead of the CLI's different default", async () => {
    queryMock.mockImplementation(() => ({ supportedModels: async () => [
      { value: "default", displayName: "Default", resolvedModel: "claude-opus-99" },
      { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-99", description: "latest sonnet" },
    ] }));
    const p = new ClaudeProvider({ path: FAKE_CLAUDE });
    expect((await p.listModels())[0]).toMatchObject({
      id: "default", resolved_model: "claude-sonnet-99", description: "latest sonnet", context_window: 1_000_000,
    });
  });
  it("keeps every live row and refreshes alias resolution without version constants", async () => {
    let version = "future-a";
    queryMock.mockImplementation(() => ({ supportedModels: async () => [
      ...["opus", "sonnet", "haiku", "fable"].map(value => ({ value, displayName: value, resolvedModel: `claude-${value}-${version}` })),
      { value: "custom", displayName: "Custom" },
    ] }));
    const p = new ClaudeProvider({ path: FAKE_CLAUDE });
    const first = await p.listModels();
    expect(first.map(m => m.id)).toEqual(["opus", "sonnet", "haiku", "fable", "custom"]);
    for (const row of first.slice(0, 4)) expect(row).toMatchObject({ context_window: 1_000_000, context_window_source: "requested" });
    expect(first.at(-1)).not.toHaveProperty("context_window");
    version = "future-b";
    expect((await p.listModels())[0]?.resolved_model).toBe("claude-opus-future-b");
  });
  it("maps supportedModels", async () => {
    queryMock.mockImplementation(() => ({
      supportedModels: async () => [{
        value: "sonnet",
        displayName: "Sonnet",
        description: "fast",
        resolvedModel: "claude-sonnet-5",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
        supportsAdaptiveThinking: true,
        supportsFastMode: true,
        supportsAutoMode: true,
      }],
    }));
    const p = new ClaudeProvider({ path: FAKE_CLAUDE });
    expect(await p.listModels()).toEqual([
      {
        id: "sonnet",
        display_name: "Sonnet",
        description: "fast",
        resolved_model: "claude-sonnet-5",
        context_window: 1_000_000,
        context_window_source: "requested",
        reasoning_efforts: [{ id: "low" }, { id: "high" }],
        supports_adaptive_thinking: true,
        supports_fast_mode: true,
        supports_auto_mode: true,
      },
    ]);
  });
});
