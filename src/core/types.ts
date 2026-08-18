/**
 * Anthropic Messages API shapes (the subset yagami implements) and the error
 * type shared across the engine and the HTTP layer.
 */

export type ApiErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: ApiErrorType,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toBody(): { type: "error"; error: { type: ApiErrorType; message: string } } {
    return { type: "error", error: { type: this.type, message: this.message } };
  }
}

export interface ContentBlockParam {
  type: string;
  [key: string]: unknown;
}

export interface TextBlockParam extends ContentBlockParam {
  type: "text";
  text: string;
}

export type SystemParam = string | TextBlockParam[];

export interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlockParam[];
}

export interface ThinkingParam {
  type: "enabled" | "disabled" | "adaptive" | string;
  budget_tokens?: number;
}

export interface MessagesRequest {
  model?: string;
  messages: MessageParam[];
  system?: SystemParam;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: Record<string, unknown>;
  service_tier?: string;
  thinking?: ThinkingParam;
  tools?: unknown;
  tool_choice?: unknown;
  /** yagami extension: Claude Code reasoning effort for this request. */
  effort?: string;
  [key: string]: unknown;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: Usage;
}

/** One server-sent event, pre-serialization. */
export interface SseEvent {
  event: string;
  data: unknown;
}
