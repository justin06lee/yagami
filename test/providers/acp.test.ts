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
    {
      id: "thought_level",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "medium", name: "Medium", description: "Balanced" },
        { value: "high", name: "High", description: "Deeper" },
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
      {
        id: "a",
        display_name: "Model A",
        reasoning_efforts: [
          { id: "medium", description: "Balanced" },
          { id: "high", description: "Deeper" },
        ],
        default_reasoning_effort: "medium",
      },
      {
        id: "b",
        display_name: "Model B",
        reasoning_efforts: [
          { id: "medium", description: "Balanced" },
          { id: "high", description: "Deeper" },
        ],
        default_reasoning_effort: "medium",
      },
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

// ── the agentic session layer ──────────────────────────────────────────

import { isSessionProvider, type SessionPermissionDecision } from "../../src/core/provider.js";

function sessionFake(opts: { permissionDecision?: SessionPermissionDecision; interactive?: boolean } = {}) {
  let handlers: AcpHandlers = {};
  const calls: Record<string, unknown[]> = { setSessionMode: [], cancel: [], newSession: [], resumeSession: [] };
  const agent = {
    newSession: async (p: unknown) => {
      calls["newSession"]!.push(p);
      return { sessionId: "ses-9", configOptions: [], modes: { currentModeId: "build", availableModes: [{ id: "build" }, { id: "plan" }] } };
    },
    resumeSession: async (p: unknown) => {
      calls["resumeSession"]!.push(p);
      return { configOptions: [], modes: null };
    },
    setSessionMode: async (p: unknown) => {
      calls["setSessionMode"]!.push(p);
      return {};
    },
    cancel: async (p: unknown) => {
      calls["cancel"]!.push(p);
    },
    prompt: async () => {
      const push = (update: unknown) => handlers.onUpdate?.({ sessionId: "ses-9", update } as never);
      if (opts.interactive) {
        push({
          sessionUpdate: "plan",
          entries: [
            { content: "Ask for a name", priority: "high", status: "in_progress" },
            { content: "Continue", priority: "medium", status: "pending" },
          ],
        });
        const answer = await (handlers as AcpHandlers & {
          onInput?: (request: unknown) => Promise<unknown>;
        }).onInput?.({
          sessionId: "ses-9",
          mode: "form",
          message: "Name the workspace",
          requestedSchema: {
            type: "object",
            properties: { name: { type: "string", title: "Workspace name" } },
            required: ["name"],
          },
        });
        push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(answer) } });
      }
      push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wor" } });
      push({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "Read README.md", kind: "read", rawInput: { path: "README.md" } });
      const answer = await (handlers.onPermission
        ? handlers.onPermission({
            sessionId: "ses-9",
            toolCall: { toolCallId: "tc-1", title: "Read README.md", kind: "read", rawInput: { path: "README.md" } },
            options: [
              { optionId: "y", name: "Yes", kind: "allow_once" },
              { optionId: "ya", name: "Always", kind: "allow_always" },
              { optionId: "n", name: "No", kind: "reject_once" },
            ],
          } as never)
        : Promise.resolve({ outcome: { outcome: "cancelled" } } as never));
      push({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: { picked: (answer as { outcome: { optionId?: string } }).outcome.optionId ?? "none" } });
      push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "king" } });
      return { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } };
    },
  };
  const closed = vi.fn();
  const conn: AcpConnection = {
    agent: agent as never,
    init: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, agentInfo: { name: "FakeAgent" } } as never,
    setHandlers: (h) => {
      handlers = h;
    },
    close: closed,
  };
  return { conn, calls, closed };
}

describe("AcpProvider.openSession", () => {
  it("is a SessionProvider", () => {
    const fake = sessionFake();
    expect(isSessionProvider(provider(fake))).toBe(true);
  });

  it("runs verbatim: no mode forcing, tool events streamed, approvals answered via the handler", async () => {
    const fake = sessionFake();
    const decisions: unknown[] = [];
    const s = provider(fake).openSession({
      cwd: "/tmp/proj",
      permissions: {
        decide: async (req) => {
          decisions.push(req.tool);
          return "allow_always";
        },
      },
    });
    const events = await collect(s.send("work"));
    await s.close();
    expect(s.id).toBe("ses-9");
    // verbatim: the agent keeps its own default mode
    expect(fake.calls["setSessionMode"]).toEqual([]);
    expect(fake.calls["newSession"]).toEqual([{ cwd: "/tmp/proj", mcpServers: [] }]);
    expect(decisions).toEqual(["Read README.md"]);
    const tools = events.filter((e) => e.type === "tool_call") as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ id: "tc-1", status: "started", kind: "read", title: "Read README.md" });
    // allow_always picked the agent's allow_always option
    expect(tools[1]).toMatchObject({ status: "completed", output: { picked: "ya" } });
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text)).toEqual(["wor", "king"]);
    expect(events.find((e) => e.type === "permission")).toMatchObject({ decision: "allow_always" });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
    expect(fake.closed).toHaveBeenCalled();
  });

  it("honors native.mode, resume, and interrupt", async () => {
    const fake = sessionFake();
    const s = provider(fake).openSession({
      cwd: "/tmp/proj",
      resume: "ses-old",
      native: { mode: "plan" },
      permissions: { decide: async () => "deny" },
    });
    await collect(s.send("hi"));
    expect(fake.calls["resumeSession"]).toEqual([{ sessionId: "ses-old", cwd: "/tmp/proj" }]);
    expect(fake.calls["setSessionMode"]).toEqual([{ sessionId: "ses-old", modeId: "plan" }]);
    await s.interrupt();
    expect(fake.calls["cancel"]).toEqual([{ sessionId: "ses-old" }]);
    await s.close();
  });

  it("forwards ACP elicitations and plan updates through the generic session contract", async () => {
    const fake = sessionFake({ interactive: true });
    const requests: Array<Record<string, unknown>> = [];
    const s = provider(fake).openSession({
      cwd: "/tmp/proj",
      permissions: { decide: async () => "allow" },
      input: {
        respond: async (request: Record<string, unknown>) => {
          requests.push(request);
          return { action: "accept", values: { name: "Ruri" } };
        },
      },
    } as never);
    const events = await collect(s.send("work"));
    await s.close();

    expect(requests[0]).toMatchObject({
      provider: "fake",
      kind: "form",
      message: "Name the workspace",
      fields: [{ id: "name", label: "Workspace name", type: "string", required: true }],
    });
    expect(events.find((event) => event.type === "plan")).toEqual({
      type: "plan",
      plan: {
        entries: [
          { content: "Ask for a name", priority: "high", status: "in_progress" },
          { content: "Continue", priority: "medium", status: "pending" },
        ],
      },
    });
    expect(events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text).join(""))
      .toContain('"content":{"name":"Ruri"}');
  });
});
