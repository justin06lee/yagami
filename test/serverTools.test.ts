import { describe, expect, it } from "vitest";
import { resolveServerTools, serverToolFor } from "../src/core/serverTools.js";
import { normalizeRequest } from "../src/core/transcript.js";
import { ApiError } from "../src/core/types.js";

describe("serverToolFor", () => {
  it("maps every dated variant of a server tool to one CLI tool", () => {
    expect(serverToolFor("web_search_20250305")).toBe("WebSearch");
    expect(serverToolFor("web_search_20260209")).toBe("WebSearch");
    expect(serverToolFor("web_fetch_20260209")).toBe("WebFetch");
    expect(serverToolFor("web_search")).toBe("WebSearch");
  });

  it("does not match a custom tool that merely starts similarly", () => {
    expect(serverToolFor("web_searcher_v2")).toBeUndefined();
    expect(serverToolFor("bash_20250124")).toBeUndefined();
    expect(serverToolFor(undefined)).toBeUndefined();
  });
});

describe("resolveServerTools", () => {
  it("returns undefined when no tools were asked for", () => {
    expect(resolveServerTools(undefined)).toBeUndefined();
    expect(resolveServerTools([])).toBeUndefined();
  });

  it("resolves and de-duplicates server tools", () => {
    const tools = [
      { type: "web_search_20260209", name: "web_search" },
      { type: "web_search_20250305", name: "web_search" },
      { type: "web_fetch_20260209", name: "web_fetch" },
    ];
    expect(resolveServerTools(tools)?.sort()).toEqual(["WebFetch", "WebSearch"]);
  });

  it("rejects custom tools by name, since nothing can execute them", () => {
    const err = (() => {
      try {
        resolveServerTools([{ name: "get_weather", input_schema: {} }]);
      } catch (e) {
        return e as ApiError;
      }
    })();
    expect(err).toBeInstanceOf(ApiError);
    expect(err!.status).toBe(400);
    expect(err!.message).toContain("get_weather");
    expect(err!.message).toContain("custom tools");
  });

  it("rejects a forced tool_choice, which server tools cannot honour", () => {
    const tools = [{ type: "web_search_20260209", name: "web_search" }];
    expect(() => resolveServerTools(tools, { type: "any" })).toThrow(ApiError);
    expect(() => resolveServerTools(tools, { type: "tool", name: "web_search" })).toThrow(ApiError);
    expect(resolveServerTools(tools, { type: "auto" })).toEqual(["WebSearch"]);
  });

  it("treats tool_choice none as no tools at all", () => {
    const tools = [{ type: "web_search_20260209", name: "web_search" }];
    expect(resolveServerTools(tools, { type: "none" })).toBeUndefined();
  });

  it("rejects tool_choice without tools", () => {
    expect(() => resolveServerTools(undefined, { type: "auto" })).toThrow(ApiError);
  });
});

describe("normalizeRequest with server tools", () => {
  it("carries resolved server tools through", () => {
    const norm = normalizeRequest({
      model: "m",
      messages: [{ role: "user", content: "who won?" }],
      tools: [{ type: "web_search_20260209", name: "web_search" }],
    });
    expect(norm.serverTools).toEqual(["WebSearch"]);
  });

  it("leaves serverTools unset for an ordinary request", () => {
    const norm = normalizeRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(norm.serverTools).toBeUndefined();
  });

  it("still refuses custom tools", () => {
    expect(() =>
      normalizeRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "emit", input_schema: { type: "object" } }],
      }),
    ).toThrow(ApiError);
  });
});
