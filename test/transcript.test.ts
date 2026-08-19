import { describe, expect, it } from "vitest";
import {
  extractSystemText,
  flattenConversation,
  normalizeRequest,
  prefillDirective,
  PrefillStripper,
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

  it("accepts image and document blocks in user messages", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aaa" } };
    const doc = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "bbb" } };
    const norm = normalizeRequest({
      model: "m",
      messages: [{ role: "user", content: [image, doc, { type: "text", text: "what's this?" }] }],
    });
    expect(norm.lastUserText).toBe("what's this?");
    expect(norm.messages[0]!.media).toEqual([image, doc]);
  });

  it("rejects media blocks without a source", () => {
    expect(() =>
      normalizeRequest({
        model: "m",
        messages: [{ role: "user", content: [{ type: "image" }] }],
      }),
    ).toThrowError(/source/);
  });

  it("rejects media blocks in assistant messages", () => {
    expect(() =>
      normalizeRequest({
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "image", source: { type: "base64" } }] },
          { role: "user", content: "again" },
        ],
      }),
    ).toThrowError(/assistant messages/);
  });

  it("rejects tool_result blocks", () => {
    expect(() =>
      normalizeRequest({
        model: "m",
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] }],
      }),
    ).toThrowError(/tool_use\/tool_result/);
  });

  it("treats a trailing assistant message as prefill", () => {
    const norm = normalizeRequest({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "The answer is" },
      ],
    });
    expect(norm.prefill).toBe("The answer is");
    expect(norm.lastUserText).toBe("hi");
    expect(norm.messages).toEqual([{ role: "user", text: "hi" }]);
  });

  it("rejects prefill without a preceding user message", () => {
    expect(() =>
      normalizeRequest({ model: "m", messages: [{ role: "assistant", content: "..." }] }),
    ).toThrowError(/prefill/);
    expect(() =>
      normalizeRequest({
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "a" },
          { role: "assistant", content: "b" },
        ],
      }),
    ).toThrowError(/prefill/);
  });

  it("rejects empty prefill", () => {
    expect(() =>
      normalizeRequest({
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "" },
        ],
      }),
    ).toThrowError(/non-empty/);
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

  it("distinguishes messages by their media blocks", () => {
    const img = (data: string) => [{ type: "image", source: { type: "base64", data } }];
    const withA = [{ role: "user" as const, text: "hi", media: img("aaa") }];
    const withB = [{ role: "user" as const, text: "hi", media: img("bbb") }];
    expect(prefixKey("s", withA)).not.toBe(prefixKey("s", msgs));
    expect(prefixKey("s", withA)).not.toBe(prefixKey("s", withB));
    expect(prefixKey("s", withA)).toBe(prefixKey("s", [{ role: "user", text: "hi", media: img("aaa") }]));
  });
});

describe("prefillDirective", () => {
  it("embeds the prefill text and the continuation instruction", () => {
    const d = prefillDirective("The answer is");
    expect(d).toContain("<assistant-prefill>\nThe answer is\n</assistant-prefill>");
    expect(d).toContain("ONLY the continuation");
  });
});

describe("PrefillStripper", () => {
  it("passes through replies that do not repeat the prefill", () => {
    const s = new PrefillStripper("The answer is");
    expect(s.push("Sure — it's 42.")).toBe("Sure — it's 42.");
    expect(s.push(" More.")).toBe(" More.");
    expect(s.flush()).toBe("");
  });

  it("strips a repeated prefill in one chunk", () => {
    const s = new PrefillStripper("The answer is");
    expect(s.push("The answer is 42.")).toBe(" 42.");
  });

  it("strips a repeated prefill split across chunks", () => {
    const s = new PrefillStripper("The answer is");
    expect(s.push("The ans")).toBe("");
    expect(s.push("wer is 4")).toBe(" 4");
    expect(s.push("2.")).toBe("2.");
  });

  it("releases held text once it diverges from the prefill", () => {
    const s = new PrefillStripper("The answer is");
    expect(s.push("The anz")).toBe("The anz");
    expect(s.push("more")).toBe("more");
  });

  it("flushes an exact bare repeat as empty, a partial hold as text", () => {
    const exact = new PrefillStripper("ab");
    expect(exact.push("ab")).toBe("");
    expect(exact.flush()).toBe("");

    const partial = new PrefillStripper("abcdef");
    expect(partial.push("abc")).toBe("");
    expect(partial.pending).toBe(true);
    expect(partial.flush()).toBe("abc");
  });

  it("does not report pending before any text arrives", () => {
    const s = new PrefillStripper("abc");
    expect(s.pending).toBe(false);
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
