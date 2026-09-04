import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { ClaudeProvider } from "../../src/core/providers/claude.js";
import { AuthRequiredError } from "../../src/core/errors.js";
import { collect } from "../helpers/fakeProvider.js";

const FAKE_CLAUDE = process.execPath;

async function* sdkRun({ text = "hello", deltas, sessionId = "sess-1", model = "claude-x", thinking }: {
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
  };
}

beforeEach(() => queryMock.mockReset());

describe("ClaudeProvider.run", () => {
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

describe("ClaudeProvider.listModels", () => {
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
        reasoning_efforts: [{ id: "low" }, { id: "high" }],
        supports_adaptive_thinking: true,
        supports_fast_mode: true,
        supports_auto_mode: true,
      },
    ]);
  });
});
