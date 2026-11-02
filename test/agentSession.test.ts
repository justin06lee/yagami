import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { AgentSession, startAgentSession } from "../src/core/agentSession.js";
import { settingSourcesFor } from "../src/core/parity.js";

const FAKE_CLAUDE = process.execPath;

/** A fake Query that echoes the first queued user turn back as an assistant message. */
function fakeQuery(contextWindow?: number) {
  const interrupt = vi.fn(async () => {});
  const setModel = vi.fn(async () => {});
  const setPermissionMode = vi.fn(async () => {});
  const close = vi.fn();
  queryMock.mockImplementation((arg) => {
    const prompt = arg?.prompt as AsyncIterable<{ message: { content: unknown } }> | undefined;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        if (!prompt) return;
        for await (const msg of prompt) {
          yield { type: "assistant", parent_tool_use_id: null, message: { model: "claude-sonnet-99", content: [{ type: "text", text: msg.message.content }] } };
          yield { type: "result", subtype: "success", session_id: "sess-1", result: "ok", modelUsage: contextWindow ? { "claude-sonnet-99": { contextWindow } } : undefined };
          break;
        }
      },
      interrupt,
      setModel,
      setPermissionMode,
      supportedModels: async () => [{ value: "sonnet", displayName: "Sonnet" }],
      close,
    };
  });
  return { interrupt, setModel, setPermissionMode, close };
}

/** Options of the (single) query() call this test made. */
function lastOptions() {
  return queryMock.mock.calls.at(-1)![0].options;
}

/** Drain a session until its first result, then close it. */
async function runOneTurn(s: AgentSession) {
  const messages = [];
  for await (const msg of s) {
    messages.push(msg);
    if (msg.type === "result") break;
  }
  return messages;
}

beforeEach(() => queryMock.mockReset());

describe("AgentSession", () => {
  it("rejects observed context downgrade without retrying the turn", async () => {
    fakeQuery(200_000);
    const s = startAgentSession("ping", { claudePath: FAKE_CLAUDE });
    await expect(runOneTurn(s)).rejects.toThrow(/requested.*1M.*200000/i);
    expect(queryMock).toHaveBeenCalledTimes(1);
    s.close();
  });
  it("exposes observed context only after a result and clears it on switch", async () => {
    fakeQuery(1_000_000);
    const s = new AgentSession({ claudePath: FAKE_CLAUDE });
    expect(s.contextWindow).toBeUndefined();
    s.send("ping");
    await runOneTurn(s);
    expect(s.contextWindow).toBe(1_000_000);
    await s.setModel("opus");
    expect(s.contextWindow).toBeUndefined();
    s.close();
  });
  it("retains a model switch made before the process starts", async () => {
    fakeQuery();
    const s = new AgentSession({ claudePath: FAKE_CLAUDE });
    await s.setModel("haiku");
    s.send("ping");
    await runOneTurn(s);
    s.close();
    expect(lastOptions().model).toBe("haiku[1m]");
  });
  it.each([
    [{}, "sonnet[1m]"],
    [{ model: "default" }, "sonnet[1m]"],
    [{ model: "opus" }, "opus[1m]"],
    [{ model: "opus", options: { model: "haiku" } }, "haiku[1m]"],
    [{ options: { model: "claude-fable-5-1" } }, "claude-fable-5-1[1m]"],
    [{ model: "external-id" }, "external-id"],
  ])("normalizes startup after extra SDK options: %j", async (options, expected) => {
    fakeQuery();
    const s = startAgentSession("ping", { claudePath: FAKE_CLAUDE, ...options });
    await runOneTurn(s);
    s.close();
    expect(lastOptions().model).toBe(expected);
  });
  it("mirrors the terminal by default and uses the claude_code preset", async () => {
    fakeQuery();
    const s = new AgentSession({ claudePath: FAKE_CLAUDE, cwd: "/proj" });
    s.send("hi");
    await runOneTurn(s);
    s.close();
    const options = lastOptions();
    expect(options.settingSources).toEqual(settingSourcesFor("terminal"));
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(options.cwd).toBe("/proj");
    expect(options.canUseTool).toBeTypeOf("function");
  });

  it("isolated parity loads no settings", async () => {
    fakeQuery();
    const s = new AgentSession({ claudePath: FAKE_CLAUDE, parity: "isolated" });
    s.send("hi");
    await runOneTurn(s);
    s.close();
    expect(lastOptions().settingSources).toEqual([]);
  });

  it("streams assistant messages for a sent turn and tracks the session id", async () => {
    fakeQuery();
    const s = startAgentSession("ping", { claudePath: FAKE_CLAUDE });
    const messages = await runOneTurn(s);
    s.close();
    expect(messages[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(messages.find((m) => m.type === "assistant")).toMatchObject({ message: { content: [{ type: "text", text: "ping" }] } });
    expect(s.sessionId).toBe("sess-1");
  });

  it("forwards lifecycle controls to the underlying query", async () => {
    const fake = fakeQuery();
    const s = new AgentSession({ claudePath: FAKE_CLAUDE });
    s.send("hi");
    await runOneTurn(s);
    await s.interrupt();
    await s.setModel("opus");
    await s.setPermissionMode("plan");
    s.close();
    expect(fake.interrupt).toHaveBeenCalled();
    expect(fake.setModel).toHaveBeenCalledWith("opus[1m]");
    expect(fake.setPermissionMode).toHaveBeenCalledWith("plan");
    expect(fake.close).toHaveBeenCalled();
  });

  it("wires the permission adapter into canUseTool", async () => {
    fakeQuery();
    const onPermission = vi.fn(async () => ({ behavior: "allow" as const }));
    const s = new AgentSession({ claudePath: FAKE_CLAUDE, onPermission });
    s.send("hi");
    await runOneTurn(s);
    s.close();
    const canUseTool = lastOptions().canUseTool;
    const res = await canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal });
    expect(res.behavior).toBe("allow");
    expect(onPermission).toHaveBeenCalled();
  });

  it("installs no canUseTool when the session starts in bypassPermissions", async () => {
    fakeQuery();
    const s = new AgentSession({
      claudePath: FAKE_CLAUDE,
      options: { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
    });
    s.send("hi");
    await runOneTurn(s);
    s.close();
    expect(lastOptions().permissionMode).toBe("bypassPermissions");
    expect(lastOptions()).not.toHaveProperty("canUseTool");
  });

  it("keeps canUseTool in bypassPermissions when the host wired permissions", async () => {
    const bypass = { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true };
    const ownCanUseTool = vi.fn();
    for (const [options, expected] of [
      [{ onPermission: async () => ({ behavior: "allow" as const }) }, "function"],
      [{ permission: { autoDeny: ["Bash"] } }, "function"],
      [{ options: { ...bypass, canUseTool: ownCanUseTool } }, ownCanUseTool],
    ] as const) {
      fakeQuery();
      const s = new AgentSession({ claudePath: FAKE_CLAUDE, options: bypass, ...options });
      s.send("hi");
      await runOneTurn(s);
      s.close();
      if (expected === "function") expect(lastOptions().canUseTool).toBeTypeOf("function");
      else expect(lastOptions().canUseTool).toBe(expected);
    }
  });

  it("refuses sending after close", () => {
    fakeQuery();
    const s = new AgentSession({ claudePath: FAKE_CLAUDE });
    s.close();
    expect(() => s.send("hi")).toThrowError(/closed/);
  });
});
