import { describe, expect, it } from "vitest";
import * as yagami from "../src/index.js";
import { claudeLongContextModel, claudeResultContextWindow } from "../src/core/claudeModels.js";

describe("claudeResultContextWindow", () => {
  it("matches primary usage despite the CLI's suffix and ignores smaller subagents", () => {
    expect(claudeResultContextWindow({ "claude-haiku-99": { contextWindow: 200_000 }, "claude-sonnet-99[1m]": { contextWindow: 1_000_000 } }, "claude-sonnet-99")).toBe(1_000_000);
  });
  it("accepts a single unambiguous usage row without assistant metadata", () => {
    expect(claudeResultContextWindow({ "claude-sonnet-99": { contextWindow: 1_000_000 } })).toBe(1_000_000);
  });
  it("does not guess primary context across multiple models", () => {
    expect(claudeResultContextWindow({ a: { contextWindow: 200_000 }, b: { contextWindow: 1_000_000 } })).toBeUndefined();
    expect(claudeResultContextWindow({ a: { contextWindow: 200_000 } }, "other")).toBeUndefined();
    expect(claudeResultContextWindow(undefined)).toBeUndefined();
  });
  it.each([0, -1, NaN, Infinity])("ignores invalid capacity %s", contextWindow => {
    expect(claudeResultContextWindow({ a: { contextWindow } }, "a")).toBeUndefined();
  });
});

describe("claudeLongContextModel", () => {
  it("is exported for bridges", () => {
    expect(yagami).toHaveProperty("claudeLongContextModel", claudeLongContextModel);
  });
  it.each(["opus", "sonnet", "haiku", "fable", "best", "claude-opus-4-6", "claude-haiku-4-5-20251001", "claude-fable-5-1"])("requests 1M for %s without changing its version", (model) => {
    expect(claudeLongContextModel(model)).toBe(`${model}[1m]`);
    expect(claudeLongContextModel(`${model}[1m]`)).toBe(`${model}[1m]`);
  });
  it.each(["custom", "sonnet-custom", "opusplan", "gpt-5", "claude-x", "claude-opus-custom", "provider/sonnet", "SONNET", " sonnet"])("preserves unknown or special selection %s", (model) => {
    expect(claudeLongContextModel(model)).toBe(model);
  });
  it.each(["", "default"])("uses dynamic Sonnet for the Yagami default %s", (model) => {
    expect(claudeLongContextModel(model)).toBe("sonnet[1m]");
  });
});
