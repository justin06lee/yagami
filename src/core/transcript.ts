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
}

export interface NormalizedRequest {
  system?: string;
  messages: NormalizedMessage[];
  lastUserText: string;
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

function contentToText(content: string | ContentBlockParam[], role: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new ApiError(400, "invalid_request_error", `message content for role "${role}" must be a string or an array of blocks`);
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type !== "text" || typeof block["text"] !== "string") {
      throw new ApiError(
        400,
        "invalid_request_error",
        `yagami only supports "text" content blocks (got "${String(block?.type)}"). Images, tool_use, and tool_result blocks are not supported.`,
      );
    }
    parts.push(block["text"] as string);
  }
  return parts.join("\n");
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

  const messages: NormalizedMessage[] = req.messages.map((m, i) => {
    if (m?.role !== "user" && m?.role !== "assistant") {
      throw new ApiError(400, "invalid_request_error", `messages[${i}].role must be "user" or "assistant"`);
    }
    return { role: m.role, text: contentToText(m.content, m.role) };
  });

  const last = messages[messages.length - 1]!;
  if (last.role !== "user") {
    throw new ApiError(
      400,
      "invalid_request_error",
      "the final message must have role \"user\" (assistant prefill is not supported by yagami)",
    );
  }

  const ignored = IGNORABLE_PARAMS.filter((p) => req[p] != null);

  return {
    system: extractSystemText(req.system),
    messages,
    lastUserText: last.text,
    ignored: [...ignored],
  };
}

/**
 * Cache key for "this exact conversation prefix has already been played
 * through a Claude Code session". Matching a prefix lets the engine resume
 * that session instead of replaying history.
 */
export function prefixKey(system: string | undefined, messages: NormalizedMessage[]): string {
  const payload = JSON.stringify([system ?? "", messages.map((m) => [m.role, m.text])]);
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
