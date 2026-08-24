/**
 * OpenAI Chat Completions dialect: translation to and from the Anthropic
 * Messages shapes the engine speaks. Pure functions — used by both the HTTP
 * server (`POST /v1/chat/completions`) and the library client
 * (`yagami.chat.completions.create`).
 */

import { ApiError, type ContentBlockParam, type MessagesRequest, type MessagesResponse, type SseEvent, type Usage } from "./types.js";
import type { EngineModel } from "./models.js";

export interface ChatMessageParam {
  role: string;
  content?: string | null | Array<{ type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ChatCompletionsRequest {
  model?: string;
  messages: ChatMessageParam[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  n?: number;
  reasoning_effort?: string;
  tools?: unknown;
  tool_choice?: unknown;
  functions?: unknown;
  function_call?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string;
    /** Thinking output (DeepSeek-style extension; no standard OpenAI field exists). */
    reasoning_content?: string;
    refusal: null;
  };
  finish_reason: string;
  logprobs: null;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: OpenAiUsage;
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string; reasoning_content?: string };
    finish_reason: string | null;
  }>;
  usage?: OpenAiUsage;
}

export interface TranslatedChatRequest {
  req: MessagesRequest;
  /** OpenAI params yagami accepted but cannot honor (adds to x-yagami-ignored). */
  extraIgnored: string[];
  /** `stream_options.include_usage` — emit the trailing usage chunk. */
  includeUsage: boolean;
}

/** OpenAI-only params that are accepted and reported as ignored, never honored. */
const IGNORED_OPENAI_PARAMS = [
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "seed",
  "user",
  "response_format",
  "prediction",
  "modalities",
  "audio",
  "store",
  "parallel_tool_calls",
  "web_search_options",
] as const;

const EFFORT_MAP: Record<string, string> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** `data:image/png;base64,...` → Anthropic image source. */
function imagePartToBlock(part: { [key: string]: unknown }): ContentBlockParam {
  const url = (part["image_url"] as { url?: unknown } | undefined)?.["url"];
  if (typeof url !== "string" || url.length === 0) {
    throw new ApiError(400, "invalid_request_error", "`image_url` parts must carry an `image_url.url` string");
  }
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataUrl) {
    return { type: "image", source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] } };
  }
  if (/^https?:\/\//.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  throw new ApiError(400, "invalid_request_error", "`image_url.url` must be a data: URL or an http(s) URL");
}

function partsToContent(
  parts: Array<{ type: string; [key: string]: unknown }>,
  role: string,
): string | ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const part of parts) {
    if (part?.type === "text" && typeof part["text"] === "string") {
      blocks.push({ type: "text", text: part["text"] });
    } else if (part?.type === "image_url" && role === "user") {
      blocks.push(imagePartToBlock(part));
    } else {
      throw new ApiError(
        400,
        "invalid_request_error",
        `unsupported content part type "${String(part?.type)}" for role "${role}" (yagami supports "text", plus "image_url" in user messages)`,
      );
    }
  }
  return blocks.every((b) => b.type === "text") ? blocks.map((b) => b["text"] as string).join("\n") : blocks;
}

function messageText(content: ChatMessageParam["content"], role: string): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  const flattened = partsToContent(content, role);
  if (typeof flattened !== "string") {
    throw new ApiError(400, "invalid_request_error", `"${role}" messages may only contain text parts`);
  }
  return flattened;
}

/**
 * Translate an OpenAI Chat Completions request into the Anthropic Messages
 * request the engine runs. Tool calling is rejected (yagami is
 * completions-only by design); knobs no CLI engine exposes are collected
 * into `extraIgnored` instead of failing the request.
 */
export function chatToMessagesRequest(body: ChatCompletionsRequest): TranslatedChatRequest {
  if (body == null || typeof body !== "object") {
    throw new ApiError(400, "invalid_request_error", "request body must be a JSON object");
  }
  if (body.tools != null || body.tool_choice != null || body.functions != null || body.function_call != null) {
    throw new ApiError(
      400,
      "invalid_request_error",
      "yagami does not support `tools`/function calling: the backing engine runs as a pure completions endpoint and never executes or emits tool calls.",
    );
  }
  if (body.n != null && body.n !== 1) {
    throw new ApiError(400, "invalid_request_error", "`n` must be 1 (yagami produces a single completion)");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ApiError(400, "invalid_request_error", "`messages` must be a non-empty array");
  }

  const systemParts: string[] = [];
  const messages: MessagesRequest["messages"] = [];
  for (const [i, m] of body.messages.entries()) {
    const role = m?.role;
    if (role === "system" || role === "developer") {
      systemParts.push(messageText(m.content, role));
    } else if (role === "user") {
      messages.push({ role: "user", content: Array.isArray(m.content) ? partsToContent(m.content, "user") : (m.content ?? "") });
    } else if (role === "assistant") {
      messages.push({ role: "assistant", content: messageText(m.content, "assistant") });
    } else if (role === "tool" || role === "function") {
      throw new ApiError(400, "invalid_request_error", "yagami does not support tool/function messages (tool calling is disabled by design)");
    } else {
      throw new ApiError(400, "invalid_request_error", `messages[${i}].role must be "system", "developer", "user", or "assistant"`);
    }
  }

  const extraIgnored = IGNORED_OPENAI_PARAMS.filter((p) => body[p] != null).map(String);

  let effort: string | undefined;
  if (body.reasoning_effort != null) {
    effort = EFFORT_MAP[String(body.reasoning_effort)];
    if (!effort) extraIgnored.push("reasoning_effort");
  }

  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  const system = systemParts.filter((s) => s.length > 0).join("\n\n");
  const req: MessagesRequest = {
    ...(body.model !== undefined ? { model: body.model } : {}),
    messages,
    ...(system.length > 0 ? { system } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
    ...(body.stop != null ? { stop_sequences: Array.isArray(body.stop) ? body.stop : [body.stop] } : {}),
    ...(body.metadata != null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    ...(body.service_tier != null ? { service_tier: String(body.service_tier) } : {}),
    ...(effort ? { effort } : {}),
    ...(body.stream === true ? { stream: true } : {}),
  };

  return { req, extraIgnored, includeUsage: body.stream_options?.include_usage === true };
}

function finishReason(stopReason: string | null): string {
  return stopReason === "max_tokens" ? "length" : "stop";
}

export function toOpenAiUsage(usage: Usage): OpenAiUsage {
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.input_tokens + usage.output_tokens,
  };
}

/** Anthropic Messages response → OpenAI chat.completion. */
export function toChatCompletion(resp: MessagesResponse): ChatCompletion {
  const text = resp.content.filter((b) => b.type === "text").map((b) => String(b["text"] ?? "")).join("");
  const thinking = resp.content.filter((b) => b.type === "thinking").map((b) => String(b["thinking"] ?? "")).join("");
  return {
    id: resp.id.replace(/^msg_/, "chatcmpl_"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text, ...(thinking ? { reasoning_content: thinking } : {}), refusal: null },
        finish_reason: finishReason(resp.stop_reason),
        logprobs: null,
      },
    ],
    usage: toOpenAiUsage(resp.usage),
  };
}

/** OpenAI-shaped error body (the OpenAI dialect's counterpart of ApiError.toBody). */
export function openAiErrorBody(err: ApiError): { error: { message: string; type: string; param: null; code: null } } {
  return { error: { message: err.message, type: err.type, param: null, code: null } };
}

/**
 * Re-emits an Anthropic SSE event sequence as OpenAI chat.completion.chunk
 * objects. Feed every engine event through `push`; the caller appends the
 * `[DONE]` sentinel (HTTP mode) unless `errored`.
 */
export class ChatChunkTranslator {
  private id = "chatcmpl_stream";
  private model = "";
  private created = Math.floor(Date.now() / 1000);
  private stopReason: string | null = null;
  private usage: Usage = { input_tokens: 0, output_tokens: 0 };
  /** Set when the engine reported an error mid-stream (no [DONE] after). */
  errored = false;

  constructor(private readonly includeUsage: boolean) {}

  private chunk(delta: ChatCompletionChunk["choices"][number]["delta"], finish: string | null = null): ChatCompletionChunk {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
  }

  /** Translate one engine SSE event into zero or more OpenAI chunk payloads. */
  push(ev: SseEvent): unknown[] {
    const data = ev.data as { [key: string]: unknown };
    switch (ev.event) {
      case "message_start": {
        const message = data["message"] as { id?: string; model?: string } | undefined;
        if (message?.id) this.id = message.id.replace(/^msg_/, "chatcmpl_");
        if (message?.model) this.model = message.model;
        return [this.chunk({ role: "assistant", content: "" })];
      }
      case "content_block_delta": {
        const delta = data["delta"] as { type?: string; text?: string; thinking?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) return [this.chunk({ content: delta.text })];
        if (delta?.type === "thinking_delta" && delta.thinking) return [this.chunk({ reasoning_content: delta.thinking })];
        return [];
      }
      case "message_delta": {
        const delta = data["delta"] as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) this.stopReason = delta.stop_reason;
        const usage = data["usage"] as Usage | undefined;
        if (usage) this.usage = usage;
        return [];
      }
      case "message_stop": {
        const out: unknown[] = [this.chunk({}, finishReason(this.stopReason))];
        if (this.includeUsage) {
          out.push({
            id: this.id,
            object: "chat.completion.chunk",
            created: this.created,
            model: this.model,
            choices: [],
            usage: toOpenAiUsage(this.usage),
          });
        }
        return out;
      }
      case "error": {
        this.errored = true;
        const error = data["error"] as { type?: string; message?: string } | undefined;
        return [{ error: { message: error?.message ?? "stream error", type: error?.type ?? "api_error", param: null, code: null } }];
      }
      default:
        return [];
    }
  }
}

/**
 * Model list body served by GET /v1/models: Anthropic fields and OpenAI
 * fields on the same objects, so both SDKs' `models.list()` parse it.
 */
export function modelListBody(models: EngineModel[]): {
  object: "list";
  data: Array<Record<string, unknown>>;
  has_more: false;
  first_id?: string;
  last_id?: string;
} {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: models.map((m) => ({ type: "model", object: "model", created, owned_by: "yagami", ...m })),
    has_more: false,
    ...(models[0] ? { first_id: models[0].id } : {}),
    ...(models.length > 0 ? { last_id: models[models.length - 1]!.id } : {}),
  };
}
