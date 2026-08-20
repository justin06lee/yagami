import { describe, expect, it, vi } from "vitest";
import type { AcpConnection, AcpHandlers } from "../../src/core/providers/acp.js";
import { AcpProvider, rejectOption } from "../../src/core/providers/acp.js";
import { AuthRequiredError, ProviderError } from "../../src/core/errors.js";
import { collect } from "../helpers/fakeProvider.js";

interface FakeOptions {
  resume?: boolean;
  models?: boolean;
  modes?: boolean;
  promptError?: Error & { code?: number };
  sessionError?: Error & { code?: number };
}

function fakeConnection(opts: FakeOptions = {}) {
  let handlers: AcpHandlers = {};
  const calls: Record<string, unknown[]> = { setSessionMode: [], setSessionConfigOption: [], cancel: [] };
  const configOptions = opts.models === false ? [] : [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "a",
      options: [
        { value: "a", name: "Model A" },
        { value: "b", name: "Model B" },
      ],
    },
  ];
  const modes = opts.modes === false ? null : { currentModeId: "build", availableModes: [{ id: "build" }, { id: "plan" }] };
  const agent = {
    newSession: async () => {
      if (opts.sessionError) throw opts.sessionError;
      return { sessionId: "ses-1", configOptions, modes };
    },
    resumeSession: async () => ({ configOptions, modes }),
    setSessionMode: async (p: unknown) => {
      calls["setSessionMode"]!.push(p);
      return {};
    },
    setSessionConfigOption: async (p: unknown) => {
      calls["setSessionConfigOption"]!.push(p);
      return {};
    },
    cancel: async (p: unknown) => {
      calls["cancel"]!.push(p);
    },
    prompt: async () => {
      if (opts.promptError) throw opts.promptError;
      const push = (update: unknown) => handlers.onUpdate?.({ sessionId: "ses-1", update } as never);
      push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
      push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "po" } });
      push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ng" } });
      push({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.002, currency: "USD" } });
      return { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } };
    },
  };
  const closed = vi.fn();
  const conn: AcpConnection = {
    agent: agent as never,
    init: {
      protocolVersion: 1,
      agentCapabilities: opts.resume === false ? {} : ({ sessionCapabilities: { resume: {} } } as never),
      agentInfo: { name: "FakeAgent", version: "9.9" },
    } as never,
    setHandlers: (h) => {
      handlers = h;
    },
    close: closed,
  };
  return { conn, calls, closed };
}

function provider(fake: ReturnType<typeof fakeConnection>) {
  return new AcpProvider({ id: "fake", label: "Fake", command: "fake-agent", connect: async () => fake.conn });
}

describe("AcpProvider.run", () => {
  it("maps session updates onto turn events and closes the agent", async () => {
    const fake = fakeConnection();
    const events = await collect(provider(fake).run({ prompt: "ping" }));
    expect(events).toEqual([
      { type: "session", sessionId: "ses-1" },
      { type: "thinking", text: "hm" },
      { type: "text", text: "po" },
      { type: "text", text: "ng" },
      {
        type: "done",
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        costUsd: 0.002,
        stopReason: "end_turn",
      },
    ]);
    expect(fake.closed).toHaveBeenCalledOnce();
  });

  it("switches to a plan mode for hardening when the agent offers one", async () => {
    const fake = fakeConnection();
    await collect(provider(fake).run({ prompt: "ping" }));
    expect(fake.calls["setSessionMode"]).toEqual([{ sessionId: "ses-1", modeId: "plan" }]);
  });

  it("selects the requested model only when it differs from the current one", async () => {
    const fake = fakeConnection();
    const p = provider(fake);
    await collect(p.run({ prompt: "ping", model: "a" }));
    expect(fake.calls["setSessionConfigOption"]).toEqual([]);
    await collect(p.run({ prompt: "ping", model: "b" }));
    expect(fake.calls["setSessionConfigOption"]).toEqual([{ sessionId: "ses-1", configId: "model", value: "b" }]);
  });

  it("errors clearly when a model is requested but the agent has no model option", async () => {
    const fake = fakeConnection({ models: false });
    await expect(collect(provider(fake).run({ prompt: "ping", model: "x" }))).rejects.toThrowError(/no model option/);
  });

  it("refuses to resume when the agent lacks resume support so the engine replays", async () => {
    const fake = fakeConnection({ resume: false });
    await expect(collect(provider(fake).run({ prompt: "two", resume: "ses-0" }))).rejects.toBeInstanceOf(ProviderError);
  });

  it("maps ACP auth-required errors onto AuthRequiredError", async () => {
    const err = Object.assign(new Error("Authentication required"), { code: -32000 });
    const fake = fakeConnection({ sessionError: err });
    await expect(collect(provider(fake).run({ prompt: "ping" }))).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("lists models from the session's model option", async () => {
    const fake = fakeConnection();
    expect(await provider(fake).listModels()).toEqual([
      { id: "a", display_name: "Model A" },
      { id: "b", display_name: "Model B" },
    ]);
    expect(fake.closed).toHaveBeenCalled();
  });

  it("reports the agent's advertised version", async () => {
    expect(await provider(fakeConnection()).version()).toBe("FakeAgent 9.9");
  });
});

describe("rejectOption", () => {
  it("prefers reject_once, then reject_always, then the first option", () => {
    const req = (kinds: string[]) =>
      ({ sessionId: "s", toolCall: { toolCallId: "t", title: "x" }, options: kinds.map((kind, i) => ({ optionId: `o${i}`, name: kind, kind })) }) as never;
    expect(rejectOption(req(["allow_once", "reject_once"]))).toEqual({ outcome: { outcome: "selected", optionId: "o1" } });
    expect(rejectOption(req(["allow_once", "reject_always"]))).toEqual({ outcome: { outcome: "selected", optionId: "o1" } });
    expect(rejectOption(req(["allow_once"]))).toEqual({ outcome: { outcome: "selected", optionId: "o0" } });
    expect(rejectOption(req([]))).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
