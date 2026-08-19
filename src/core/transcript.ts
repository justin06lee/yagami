import { createHash } from "node:crypto";
import {
  ApiError,
  type MessagesRequest,
  type SystemParam,
  type ContentBlockParam,
} from "./types.js";

export interface NormalizedMessage {
  role: "user" | "assistant";
  text: string;
  /** Image/document blocks (user messages only), passed through to the engine. */
  media?: ContentBlockParam[];
}

export interface NormalizedRequest {
  system?: string;
  /** The conversation ending in the final user message (prefill removed). */
  messages: NormalizedMessage[];
  lastUserText: string;
  /** Trailing assistant message text: the reply must continue from here. */
  prefill?: string;
  /** Accepted-but-ignored request params, surfaced via a response header. */
  ignored: string[];
}

/** Params the engine cannot honor but that shouldn't fail the request. */
const IGNORABLE_PARAMS = [
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "metadata",
  "service_tier",
] as const;

export function extractSystemText(system: SystemParam | undefined): string | undefined {
  if (system == null) return undefined;
  if (typeof system === "string") return system.length > 0 ? system : undefined;
  if (!Array.isArray(system)) {
    throw new ApiError(400, "invalid_request_error", "`system` must be a string or an array of text blocks");
  }
  const parts: string[] = [];
  for (const block of system) {
    if (block?.type !== "text" || typeof block.text !== "string") {
      throw new ApiError(400, "invalid_request_error", "yagami only supports text blocks in `system`");
    }
    parts.push(block.text);
  }
  const joined = parts.join("\n\n");
  return joined.length > 0 ? joined : undefined;
}

/** Block types (besides text) accepted in user messages and forwarded raw. */
const USER_MEDIA_TYPES: ReadonlySet<string> = new Set(["image", "document"]);

function contentToParts(
  content: string | ContentBlockParam[],
  role: string,
): { text: string; media: ContentBlockParam[] } {
  if (typeof content === "string") return { text: content, media: [] };
  if (!Array.isArray(content)) {
    throw new ApiError(400, "invalid_request_error", `message content for role "${role}" must be a string or an array of blocks`);
  }
  const parts: string[] = [];
  const media: ContentBlockParam[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block["text"] === "string") {
      parts.push(block["text"] as string);
    } else if (role === "user" && USER_MEDIA_TYPES.has(String(block?.type))) {
      if (block["source"] == null || typeof block["source"] !== "object") {
        throw new ApiError(
          400,
          "invalid_request_error",
          `"${block.type}" blocks must carry a \`source\` object`,
        );
      }
      media.push(block);
    } else {
      throw new ApiError(
        400,
        "invalid_request_error",
        role === "user"
          ? `unsupported content block type "${String(block?.type)}" (user messages may contain text, image, and document blocks; tool_use/tool_result are not supported)`
          : `assistant messages may only contain "text" blocks (got "${String(block?.type)}")`,
      );
    }
  }
  return { text: parts.join("\n"), media };
}

export function normalizeRequest(req: MessagesRequest): NormalizedRequest {
  if (req == null || typeof req !== "object") {
    throw new ApiError(400, "invalid_request_error", "request body must be a JSON object");
  }
  if (req.tools != null || req.tool_choice != null) {
    throw new ApiError(
      400,
      "invalid_request_error",
      "yagami does not support `tools`/`tool_choice`: the backing engine runs as a pure completions endpoint and never executes or emits tool calls.",
    );
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new ApiError(400, "invalid_request_error", "`messages` must be a non-empty array");
  }

  let messages: NormalizedMessage[] = req.messages.map((m, i) => {
    if (m?.role !== "user" && m?.role !== "assistant") {
      throw new ApiError(400, "invalid_request_error", `messages[${i}].role must be "user" or "assistant"`);
    }
    const { text, media } = contentToParts(m.content, m.role);
    return media.length > 0 ? { role: m.role, text, media } : { role: m.role, text };
  });

  // A trailing assistant message is prefill: the reply continues from it.
  let prefill: string | undefined;
  if (messages[messages.length - 1]!.role === "assistant") {
    prefill = messages[messages.length - 1]!.text;
    messages = messages.slice(0, -1);
    if (prefill.length === 0) {
      throw new ApiError(400, "invalid_request_error", "assistant prefill must contain non-empty text");
    }
    if (messages.length === 0 || messages[messages.length - 1]!.role !== "user") {
      throw new ApiError(
        400,
        "invalid_request_error",
        "assistant prefill must directly follow a user message",
      );
    }
  }

  const last = messages[messages.length - 1]!;
  if (last.role !== "user") {
    throw new ApiError(400, "invalid_request_error", "the final message must have role \"user\"");
  }

  const ignored = IGNORABLE_PARAMS.filter((p) => req[p] != null);

  return {
    system: extractSystemText(req.system),
    messages,
    lastUserText: last.text,
    ...(prefill !== undefined ? { prefill } : {}),
    ignored: [...ignored],
  };
}

/**
 * Instruction appended to the outgoing prompt when the request ends with an
 * assistant prefill. The engine can't literally seed the assistant turn, so
 * the model is told to continue from the prefill text instead.
 */
export function prefillDirective(prefill: string): string {
  return [
    "<assistant-prefill>",
    prefill,
    "</assistant-prefill>",
    "",
    "Your reply has already been started with the exact text inside <assistant-prefill>.",
    "Continue seamlessly from where it stops. Output ONLY the continuation — do not",
    "repeat any part of the prefill and do not acknowledge these instructions.",
  ].join("\n");
}

/**
 * Removes an accidentally repeated prefill from the front of the reply,
 * incrementally, so it works on stream deltas as well as whole responses.
 * Holds text back only until the "did the model repeat the prefill?"
 * question is settled, then passes everything through untouched.
 */
export class PrefillStripper {
  private buffer = "";
  private settled = false;

  constructor(private readonly prefill: string) {}

  /** True while text is being held back pending the repeat/no-repeat call. */
  get pending(): boolean {
    return !this.settled && this.buffer.length > 0;
  }

  /** Feed a chunk of reply text; returns the text safe to emit now. */
  push(chunk: string): string {
    if (this.settled) return chunk;
    this.buffer += chunk;
    if (this.buffer.length <= this.prefill.length) {
      if (this.prefill.startsWith(this.buffer)) return ""; // still ambiguous — hold
      this.settled = true;
      const out = this.buffer;
      this.buffer = "";
      return out;
    }
    this.settled = true;
    const out = this.buffer.startsWith(this.prefill)
      ? this.buffer.slice(this.prefill.length)
      : this.buffer;
    this.buffer = "";
    return out;
  }

  /** Emit whatever is still held once the reply has ended. */
  flush(): string {
    if (this.settled) return "";
    this.settled = true;
    // Held text is a prefix of the prefill: a full match is a bare repeat
    // (empty continuation); a partial one is emitted rather than dropped.
    const out = this.buffer === this.prefill ? "" : this.buffer;
    this.buffer = "";
    return out;
  }
}

/**
 * Cache key for "this exact conversation prefix has already been played
 * through a Claude Code session". Matching a prefix lets the engine resume
 * that session instead of replaying history.
 */
export function prefixKey(system: string | undefined, messages: NormalizedMessage[]): string {
  // Media identity is folded in as a digest; text-only messages keep the
  // original payload shape so existing persisted caches stay valid.
  const payload = JSON.stringify([
    system ?? "",
    messages.map((m) =>
      m.media && m.media.length > 0
        ? [m.role, m.text, createHash("sha256").update(JSON.stringify(m.media)).digest("hex")]
        : [m.role, m.text],
    ),
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Fallback for histories no cached session matches: render the whole
 * conversation into a single prompt for a fresh session.
 */
export function flattenConversation(messages: NormalizedMessage[]): string {
  const history = messages.slice(0, -1);
  const last = messages[messages.length - 1]!;
  const lines = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`);
  return [
    "<conversation-history>",
    "This is the conversation so far between the user (User) and you (Assistant):",
    ...lines,
    "</conversation-history>",
    "",
    "Continue that conversation naturally. Respond to the user's latest message:",
    "",
    last.text,
  ].join("\n");
}
