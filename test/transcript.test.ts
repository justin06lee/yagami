import { describe, expect, it } from "vitest";
import {
  extractSystemText,
  flattenConversation,
  normalizeRequest,
  prefixKey,
} from "../src/core/transcript.js";
import { ApiError } from "../src/core/types.js";

describe("normalizeRequest", () => {
  it("accepts string content", () => {
    const norm = normalizeRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(norm.lastUserText).toBe("hi");
    expect(norm.messages).toEqual([{ role: "user", text: "hi" }]);
  });

  it("accepts text block content and joins blocks", () => {
    const norm = normalizeRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    });
    expect(norm.lastUserText).toBe("a\nb");
  });

  it("rejects tools", () => {
    expect(() =>
      normalizeRequest({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [{}] }),
    ).toThrowError(ApiError);
  });

  it("rejects image blocks", () => {
    expect(() =>
      normalizeRequest({
        model: "m",
        messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
      }),
    ).toThrowError(/text/);
  });

  it("rejects assistant prefill (last message not user)", () => {
    expect(() =>
      normalizeRequest({
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "The answer is" },
        ],
      }),
    ).toThrowError(/prefill/);
  });

  it("rejects empty messages", () => {
    expect(() => normalizeRequest({ model: "m", messages: [] })).toThrowError(ApiError);
  });

  it("collects ignored params", () => {
    const norm = normalizeRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      temperature: 0.5,
    });
    expect(norm.ignored.sort()).toEqual(["max_tokens", "temperature"]);
  });
});

describe("extractSystemText", () => {
  it("passes strings through and joins text blocks", () => {
    expect(extractSystemText("sys")).toBe("sys");
    expect(extractSystemText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\n\nb");
    expect(extractSystemText(undefined)).toBeUndefined();
    expect(extractSystemText("")).toBeUndefined();
  });
});

describe("prefixKey", () => {
  const msgs = [{ role: "user" as const, text: "hi" }];

  it("is stable for identical input", () => {
    expect(prefixKey("s", msgs)).toBe(prefixKey("s", [{ role: "user", text: "hi" }]));
  });

  it("changes when system or messages change", () => {
    expect(prefixKey("s", msgs)).not.toBe(prefixKey("other", msgs));
    expect(prefixKey("s", msgs)).not.toBe(prefixKey("s", [{ role: "user", text: "yo" }]));
    expect(prefixKey("s", msgs)).not.toBe(prefixKey("s", [{ role: "assistant", text: "hi" }]));
  });
});

describe("flattenConversation", () => {
  it("renders history and keeps the last user message as the ask", () => {
    const flat = flattenConversation([
      { role: "user", text: "one" },
      { role: "assistant", text: "two" },
      { role: "user", text: "three" },
    ]);
    expect(flat).toContain("User: one");
    expect(flat).toContain("Assistant: two");
    expect(flat.trim().endsWith("three")).toBe(true);
    expect(flat).not.toContain("User: three");
  });
});
