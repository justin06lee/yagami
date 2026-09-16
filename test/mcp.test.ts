import { describe, expect, it } from "vitest";
import { YagamiEngine } from "../src/core/engine.js";
import {
  flattenToolResultContent,
  mcpToolAllowed,
  parseMcpToolName,
  resolveMcpServers,
} from "../src/core/mcp.js";
import { SessionCache } from "../src/core/sessionCache.js";
import { normalizeRequest } from "../src/core/transcript.js";
import { ApiError } from "../src/core/types.js";
import type { TurnEvent } from "../src/core/provider.js";
import { collect, FakeProvider, FULL_CAPS } from "./helpers/fakeProvider.js";

const SERVER = { type: "url", url: "http://127.0.0.1:4321/mcp", name: "editor" };
const TOOLSET = { type: "mcp_toolset", mcp_server_name: "editor" };
const USER = (content: string) => ({ role: "user" as const, content });

function expectApiError(fn: () => unknown, fragment: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(400);
  expect((err as ApiError).message).toContain(fragment);
}

describe("resolveMcpServers", () => {
  it("returns undefined when nothing MCP-shaped was sent", () => {
    expect(resolveMcpServers(undefined, undefined)).toBeUndefined();
    expect(resolveMcpServers(undefined, [{ type: "web_search_20260209", name: "web_search" }])).toBeUndefined();
  });

  it("enables only the servers an mcp_toolset references and strips those entries from tools", () => {
    const resolved = resolveMcpServers(
      [SERVER, { type: "url", url: "http://127.0.0.1:9/mcp", name: "unused" }],
      [TOOLSET, { type: "web_search_20260209", name: "web_search" }],
    );
    expect(Object.keys(resolved!.servers)).toEqual(["editor"]);
    expect(resolved!.servers["editor"]).toEqual({ url: "http://127.0.0.1:4321/mcp" });
    expect(resolved!.remainingTools).toEqual([{ type: "web_search_20260209", name: "web_search" }]);
  });

  it("turns authorization_token into a bearer header and honours allowed_tools", () => {
    const resolved = resolveMcpServers(
      [{ ...SERVER, authorization_token: "tok", tool_configuration: { allowed_tools: ["read_file"] } }],
      [TOOLSET],
    );
    expect(resolved!.servers["editor"]).toEqual({
      url: "http://127.0.0.1:4321/mcp",
      headers: { Authorization: "Bearer tok" },
      allowedTools: ["read_file"],
    });
  });

  it("skips servers switched off with tool_configuration.enabled=false", () => {
    const resolved = resolveMcpServers([{ ...SERVER, tool_configuration: { enabled: false } }], [TOOLSET]);
    expect(resolved!.servers).toEqual({});
  });

  it("rejects malformed declarations in the API's words", () => {
    expectApiError(() => resolveMcpServers("nope", [TOOLSET]), "must be an array");
    expectApiError(() => resolveMcpServers([{ ...SERVER, type: "sse" }], [TOOLSET]), 'type must be "url"');
    expectApiError(() => resolveMcpServers([{ ...SERVER, url: "ftp://x" }], [TOOLSET]), "http(s) URL");
    expectApiError(() => resolveMcpServers([{ ...SERVER, name: "bad name!" }], [TOOLSET]), "1-64 characters");
    expectApiError(() => resolveMcpServers([SERVER, SERVER], [TOOLSET]), "more than once");
    expectApiError(() => resolveMcpServers([SERVER], [{ type: "mcp_toolset", mcp_server_name: "other" }]), "not declared");
    expectApiError(() => resolveMcpServers(undefined, [TOOLSET]), "declares no `mcp_servers`");
  });
});

describe("MCP tool names", () => {
  it("splits Claude Code's mcp__server__tool names", () => {
    expect(parseMcpToolName("mcp__editor__read_file")).toEqual({ server: "editor", tool: "read_file" });
    expect(parseMcpToolName("mcp__a-b__get__thing")).toEqual({ server: "a-b", tool: "get__thing" });
    expect(parseMcpToolName("WebSearch")).toBeUndefined();
    expect(parseMcpToolName("mcp____x")).toBeUndefined();
  });

  it("applies allow and deny lists", () => {
    expect(mcpToolAllowed({ url: "u" }, "anything")).toBe(true);
    expect(mcpToolAllowed({ url: "u", allowedTools: ["a"] }, "a")).toBe(true);
    expect(mcpToolAllowed({ url: "u", allowedTools: ["a"] }, "b")).toBe(false);
    expect(mcpToolAllowed({ url: "u", allowedTools: ["!b|c"] }, "a")).toBe(true);
    expect(mcpToolAllowed({ url: "u", allowedTools: ["!b|c"] }, "c")).toBe(false);
  });

  it("flattens tool result content", () => {
    expect(flattenToolResultContent("plain")).toBe("plain");
    expect(flattenToolResultContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(flattenToolResultContent(undefined)).toBe("");
  });
});

describe("normalizeRequest with MCP", () => {
  it("carries the resolved servers and keeps server tools working alongside", () => {
    const norm = normalizeRequest({
      messages: [USER("hi")],
      mcp_servers: [SERVER],
      tools: [TOOLSET, { type: "web_fetch_20260209", name: "web_fetch" }],
    });
    expect(norm.mcpServers).toEqual({ editor: { url: "http://127.0.0.1:4321/mcp" } });
    expect(norm.serverTools).toEqual(["WebFetch"]);
  });

  it("accepts mcp_tool_use / mcp_tool_result blocks echoed back in assistant history", () => {
    const norm = normalizeRequest({
      messages: [
        USER("what is the root node?"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look." },
            { type: "mcp_tool_use", id: "t1", name: "get_scene_tree", server_name: "editor", input: {} },
            { type: "mcp_tool_result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: "Main (Node2D)" }] },
            { type: "text", text: "The root is Main." },
          ],
        },
        USER("thanks"),
      ],
    });
    expect(norm.messages[1]!.text).toBe("Let me look.\nThe root is Main.");
    expect(norm.messages[1]!.toolTrace).toEqual([
      "[called get_scene_tree on editor with {}]",
      "[get_scene_tree returned: Main (Node2D)]",
    ]);
  });

  it("still rejects client tool_use / tool_result blocks", () => {
    expectApiError(
      () =>
        normalizeRequest({
          messages: [USER("x"), { role: "assistant", content: [{ type: "tool_use", id: "1", name: "f", input: {} }] }, USER("y")],
        }),
      'assistant messages may only contain "text"',
    );
  });
});

function mcpTurn(): TurnEvent[] {
  return [
    { type: "session", sessionId: "sess-mcp" },
    { type: "text", text: "Checking. " },
    { type: "tool_use", id: "toolu_1", name: "get_scene_tree", serverName: "editor", input: {} },
    { type: "tool_result", toolUseId: "toolu_1", isError: false, content: "Main (Node2D)" },
    { type: "text", text: "The root is Main." },
    { type: "done", usage: { input_tokens: 3, output_tokens: 5 } },
  ];
}

describe("engine with MCP servers", () => {
  const makeEngine = (providers: FakeProvider[]) =>
    new YagamiEngine({ providers, defaultProvider: providers[0]!.id, sessionCache: new SessionCache() });

  it("hands the servers to a capable provider and streams tool activity as MCP blocks", async () => {
    const fake = new FakeProvider("fake", FULL_CAPS, () => mcpTurn());
    const engine = makeEngine([fake]);
    const { events } = engine.stream({ messages: [USER("root?")], mcp_servers: [SERVER], tools: [TOOLSET], stream: true });
    const all = await collect(events);
    expect(fake.calls[0]!.mcpServers).toEqual({ editor: { url: "http://127.0.0.1:4321/mcp" } });

    const starts = all
      .filter((e) => e.event === "content_block_start")
      .map((e) => (e.data as { content_block: Record<string, unknown> }).content_block);
    expect(starts.map((b) => b["type"])).toEqual(["text", "mcp_tool_use", "mcp_tool_result", "text"]);
    expect(starts[1]).toEqual({ type: "mcp_tool_use", id: "toolu_1", name: "get_scene_tree", server_name: "editor", input: {} });
    expect(starts[2]).toEqual({
      type: "mcp_tool_result",
      tool_use_id: "toolu_1",
      is_error: false,
      content: [{ type: "text", text: "Main (Node2D)" }],
    });
    const last = all[all.length - 1]!;
    expect(last.event).toBe("message_stop");
    const delta = all.find((e) => e.event === "message_delta")!.data as { delta: { stop_reason: string } };
    expect(delta.delta.stop_reason).toBe("end_turn");
  });

  it("returns ordered MCP blocks on the non-streaming path", async () => {
    const fake = new FakeProvider("fake", FULL_CAPS, () => mcpTurn());
    const engine = makeEngine([fake]);
    const result = await engine.complete({ messages: [USER("root?")], mcp_servers: [SERVER], tools: [TOOLSET] });
    expect(result.response.content.map((b) => b.type)).toEqual(["text", "mcp_tool_use", "mcp_tool_result", "text"]);
    expect(result.response.content[0]).toEqual({ type: "text", text: "Checking. " });
    expect(result.response.content[3]).toEqual({ type: "text", text: "The root is Main." });
  });

  it("remembers the session under the reply text alone, so follow-ups resume", async () => {
    const fake = new FakeProvider("fake", FULL_CAPS, () => mcpTurn());
    const engine = makeEngine([fake]);
    await engine.complete({ messages: [USER("root?")], mcp_servers: [SERVER], tools: [TOOLSET] });
    await engine.complete({
      messages: [
        USER("root?"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking. " },
            { type: "mcp_tool_use", id: "toolu_1", name: "get_scene_tree", server_name: "editor", input: {} },
            { type: "mcp_tool_result", tool_use_id: "toolu_1", is_error: false, content: "Main (Node2D)" },
            { type: "text", text: "The root is Main." },
          ],
        },
        USER("and its type?"),
      ],
      mcp_servers: [SERVER],
      tools: [TOOLSET],
    });
    expect(fake.calls[1]!.resume).toBe("sess-mcp");
    expect(fake.calls[1]!.prompt).toBe("and its type?");
  });

  it("refuses MCP servers on providers that cannot connect them", async () => {
    const fake = new FakeProvider("codexish", { ...FULL_CAPS, mcpServers: false });
    const engine = makeEngine([fake]);
    await expect(engine.complete({ messages: [USER("x")], mcp_servers: [SERVER], tools: [TOOLSET] })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("MCP"),
    });
  });
});
