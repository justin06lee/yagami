import type { SseEvent, Usage } from "./types.js";

/**
 * Builds a valid Anthropic SSE event sequence from normalized provider
 * events: message_start → content blocks (thinking and/or text, each with
 * start/deltas/stop) → message_delta → message_stop.
 */
export class SseSynthesizer {
  private index = -1;
  private open: "text" | "thinking" | null = null;
  private startedBlocks = 0;

  constructor(
    private readonly id: string,
    private readonly model: string,
  ) {}

  start(): SseEvent[] {
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: this.id,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
    ];
  }

  thinking(text: string): SseEvent[] {
    if (text.length === 0) return [];
    const out = this.ensure("thinking");
    out.push({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: this.index, delta: { type: "thinking_delta", thinking: text } },
    });
    return out;
  }

  text(text: string): SseEvent[] {
    if (text.length === 0) return [];
    const out = this.ensure("text");
    out.push({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text } },
    });
    return out;
  }

  finish(usage: Usage, stopReason = "end_turn"): SseEvent[] {
    const out: SseEvent[] = [];
    // Always deliver at least one (possibly empty) text block so clients
    // that index content[0] never see a bare message.
    if (this.startedBlocks === 0) out.push(...this.ensure("text"));
    out.push(...this.closeOpen());
    out.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      },
    });
    out.push({ event: "message_stop", data: { type: "message_stop" } });
    return out;
  }

  private ensure(kind: "text" | "thinking"): SseEvent[] {
    if (this.open === kind) return [];
    const out = this.closeOpen();
    this.index += 1;
    this.startedBlocks += 1;
    this.open = kind;
    out.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: this.index,
        content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
      },
    });
    return out;
  }

  private closeOpen(): SseEvent[] {
    if (this.open === null) return [];
    this.open = null;
    return [{ event: "content_block_stop", data: { type: "content_block_stop", index: this.index } }];
  }
}
