import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAgentSession } from "../../src/core/providers/codexSession.js";
import { isSessionProvider } from "../../src/core/provider.js";
import { CodexProvider } from "../../src/core/providers/codex.js";
import type { AgentEvent, SessionPermissionDecision } from "../../src/core/provider.js";
import { collect } from "../helpers/fakeProvider.js";

const FAKE = path.join(import.meta.dirname, "..", "helpers", "fake-app-server.cjs");
fs.chmodSync(FAKE, 0o755);

function session(decision: SessionPermissionDecision, resume?: string, input?: unknown, forkAt?: string) {
  return new CodexAgentSession({
    executable: FAKE,
    env: process.env,
    loginCommand: "codex login",
    options: {
      cwd: "/tmp",
      permissions: { decide: async () => decision },
      ...(input ? { input } : {}),
      ...(resume ? { resume } : {}),
      ...(forkAt ? { forkAt } : {}),
    } as never,
  });
}

describe("CodexAgentSession", () => {
  it("is detected by isSessionProvider on CodexProvider", () => {
    expect(isSessionProvider(new CodexProvider({ path: process.execPath, workDir: "/tmp/yagami-test-ws" }))).toBe(true);
  });

  it("streams a full turn: deltas, tool events, approval round-trip, gap fill, usage", async () => {
    const s = session("allow");
    const events = await collect(s.send("run it"));
    await s.close();
    expect(s.id).toBe("th-fake-1");
    expect(events[0]).toEqual({ type: "session", sessionId: "th-fake-1" });
    const own = events.filter((e: AgentEvent) => !("thread" in e));
    expect(own.filter((e: AgentEvent) => e.type === "text").map((e) => (e as { text: string }).text)).toEqual([
      "hel",
      "lo",
      " there", // item/completed fills what the deltas didn't cover
    ]);
    // the spawned agent's own work arrives whole and tagged with its thread;
    // its delta, its turn ending and a stranger thread's message do not
    expect(events.filter((e: AgentEvent) => "thread" in e)).toEqual([
      expect.objectContaining({ type: "tool_call", name: "shell", status: "started", title: "bun test", thread: "sub-1" }),
      { type: "text", text: "All tests pass.", thread: "sub-1" },
    ]);
    expect(JSON.stringify(events)).not.toContain("not ours");
    const tools = own.filter((e: AgentEvent) => e.type === "tool_call") as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: "spawn_agent", status: "started", title: "Check the tests" });
    expect(tools[1]).toMatchObject({ name: "spawn_agent", status: "completed" });
    expect(tools[2]).toMatchObject({ name: "shell", status: "started", title: "echo hi" });
    expect(tools[3]).toMatchObject({ name: "shell", status: "completed" });
    expect((tools[3]!["output"] as { output: string }).output).toBe('decision="accept" currentTime=true');
    const perm = events.find((e: AgentEvent) => e.type === "permission") as Record<string, unknown>;
    expect(perm).toMatchObject({ decision: "allow" });
    expect(events.at(-1)).toEqual({
      type: "done",
      usage: { input_tokens: 30, output_tokens: 20, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 },
      stopReason: "end_turn",
    });
  });

  it("maps allow_always to acceptForSession and deny to a declined execution", async () => {
    const always = session("allow_always");
    const alwaysEvents = await collect(always.send("go"));
    await always.close();
    const alwaysTool = alwaysEvents.filter((e) => e.type === "tool_call").at(-1) as Record<string, unknown>;
    expect((alwaysTool["output"] as { output: string }).output).toBe('decision="acceptForSession" currentTime=true');

    const denied = session("deny");
    const deniedEvents = await collect(denied.send("go"));
    await denied.close();
    const deniedTool = deniedEvents.filter((e) => e.type === "tool_call").at(-1) as Record<string, unknown>;
    expect(deniedTool).toMatchObject({ status: "failed" });
    expect((deniedTool["output"] as { output: string }).output).toBe('decision="decline" currentTime=true');
  });

  it("resumes an existing thread by id", async () => {
    const s = session("allow", "th-old-7");
    const events = await collect(s.send("hi"));
    await s.close();
    expect(s.id).toBe("th-old-7");
    expect(events[0]).toEqual({ type: "session", sessionId: "th-old-7" });
  });

  it("forks a resumed thread through an exact turn and reports turn ids", async () => {
    const s = session("allow", "th-old-7", undefined, "turn-41");
    const events = await collect(s.send("continue here"));
    await s.close();
    expect(s.id).toBe("th-old-7-fork-turn-41");
    expect(events[0]).toEqual({ type: "session", sessionId: "th-old-7-fork-turn-41" });
    expect(events[1]).toEqual({ type: "turn", id: "turn-1" });
  });

  it("forwards questions and MCP elicitations and streams live plans", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const s = session("allow", undefined, {
      respond: async (request: Record<string, unknown>) => {
        requests.push(request);
        return request.kind === "questions"
          ? { action: "accept", values: { destination: ["Tokyo"] } }
          : { action: "accept", values: { name: "Ruri" } };
      },
    });
    const events = await collect(s.send("[interactive] ask me first"));
    await s.close();

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      provider: "codex",
      kind: "questions",
      message: "Where should we go?",
      fields: [
        {
          id: "destination",
          label: "Where should we go?",
          type: "select",
          required: true,
          allowOther: true,
          secret: false,
        },
      ],
    });
    expect(requests[1]).toMatchObject({
      provider: "codex",
      kind: "form",
      source: "demo",
      message: "Name this workspace",
      fields: [{ id: "name", label: "Workspace name", type: "string", required: true }],
    });
    expect(events.find((event) => event.type === "plan")).toEqual({
      type: "plan",
      plan: {
        explanation: "Answer before continuing",
        entries: [
          { content: "Collect preferences", status: "in_progress" },
          { content: "Finish the task", status: "pending" },
        ],
      },
    });
    expect(events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text).join(""))
      .toContain('"destination":{"answers":["Tokyo"]}');
    expect(events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text).join(""))
      .toContain('"content":{"name":"Ruri"}');
  });

  it("preserves the Codex model catalog's capability metadata", async () => {
    const p = new CodexProvider({ path: FAKE, workDir: "/tmp/yagami-test-ws" });
    await expect(p.listModels()).resolves.toEqual([
      {
        id: "gpt-test",
        display_name: "GPT Test",
        description: "A test model",
        reasoning_efforts: [
          { id: "medium", description: "Balanced" },
          { id: "high", description: "Deeper" },
        ],
        default_reasoning_effort: "medium",
        input_modalities: ["text", "image"],
        supports_personality: true,
        multi_agent: "v2",
        service_tiers: [{ id: "priority", display_name: "Priority", description: "Lower latency" }],
        default_service_tier: "priority",
        is_default: true,
      },
    ]);
  });
  it("streams reasoning deltas without repeating the completed summary", async () => {
    const s = session("allow");
    try {
      const events = await collect(s.send("[reasoning] inspect the files"));
      expect(events.filter((event) => event.type === "thinking").map((event) => event.text))
        .toEqual(["Checking ", "the files", " carefully"]);
    } finally { await s.close(); }
  });

  it("does not silently replace an unavailable resumed conversation", async () => {
    const s = session("allow", "th-unavailable");
    try {
      await expect(collect(s.send("continue"))).rejects.toThrow("service unavailable");
      expect(s.id).toBeUndefined();
    } finally { await s.close(); }
  });

  it("rejects concurrent sends even while the thread is opening", async () => {
    const s = session("allow");
    try {
      const first = collect(s.send("first"));
      await expect(collect(s.send("second"))).rejects.toThrow("already running");
      expect((await first).at(-1)?.type).toBe("done");
    } finally { await s.close(); }
  });

  it("cancels an input handler when the turn is interrupted", async () => {
    let inputSignal: AbortSignal | undefined;
    let ready!: () => void;
    const asked = new Promise<void>((resolve) => { ready = resolve; });
    const s = session("allow", undefined, {
      respond: (_request: unknown, signal?: AbortSignal) => {
        inputSignal = signal;
        ready();
        return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true }));
      },
    });
    try {
      const running = collect(s.send("[interactive] wait for me"));
      await asked;
      await s.interrupt();
      expect(inputSignal?.aborted).toBe(true);
      expect((await running).at(-1)).toMatchObject({ type: "done", stopReason: "interrupted" });
    } finally { await s.close(); }
  });

  it("surfaces the authoritative proposed plan item", async () => {
    const s = session("allow");
    try {
      const events = await collect(s.send("[plan] plan the change"));
      expect(events.find((event) => event.type === "plan"))
        .toEqual({ type: "plan", plan: { id: "plan-1", markdown: "Inspect, implement, verify." } });
    } finally { await s.close(); }
  });

  it("survives malformed notifications without dropping the turn", async () => {
    const s = session("allow");
    try {
      const events = await collect(s.send("[malformed] run it"));
      const own = events.filter((e: AgentEvent) => !("thread" in e));
      expect(own.filter((e: AgentEvent) => e.type === "text").map((e) => (e as { text: string }).text)).toEqual(["hel", "lo", " there"]);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
    } finally { await s.close(); }
  });

  it("fails the turn, not the host, when the app-server dies mid-turn", async () => {
    const s = session("allow");
    try {
      await expect(collect(s.send("[die] run it"))).rejects.toThrow(/exited with code 3/);
      // the session is spent: a later send does not hang or crash either
      await expect(collect(s.send("again"))).rejects.toThrow();
    } finally { await s.close(); }
  });

  it("dismisses an input request resolved by the server", async () => {
    let cancelled = false;
    const s = session("allow", undefined, {
      respond: (_request: unknown, signal?: AbortSignal) => new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          cancelled = true;
          resolve({ action: "cancel" });
        }, { once: true });
      }),
    });
    try {
      const events = await collect(s.send("[interactive] [resolved]"));
      expect(cancelled).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "end_turn" });
    } finally { await s.close(); }
  });

});
