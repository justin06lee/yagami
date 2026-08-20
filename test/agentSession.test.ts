import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { AgentSession, startAgentSession } from "../src/core/agentSession.js";
import { settingSourcesFor } from "../src/core/parity.js";

const FAKE_CLAUDE = process.execPath;

/** A fake Query that echoes the first queued user turn back as an assistant message. */
function fakeQuery() {
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
          yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: msg.message.content }] } };
          yield { type: "result", subtype: "success", session_id: "sess-1", result: "ok" };
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
    expect(fake.setModel).toHaveBeenCalledWith("opus");
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

  it("refuses sending after close", () => {
    fakeQuery();
    const s = new AgentSession({ claudePath: FAKE_CLAUDE });
    s.close();
    expect(() => s.send("hi")).toThrowError(/closed/);
  });
});
