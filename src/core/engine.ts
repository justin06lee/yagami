import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  query,
  type CanUseTool,
  type Options,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type ThinkingConfig,
  type EffortLevel,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExecutable } from "./executable.js";
import { SessionCache } from "./sessionCache.js";
import {
  flattenConversation,
  normalizeRequest,
  prefixKey,
  type NormalizedRequest,
} from "./transcript.js";
import {
  ApiError,
  type ContentBlock,
  type MessagesRequest,
  type MessagesResponse,
  type SseEvent,
  type Usage,
} from "./types.js";
import { VERSION } from "../version.js";

const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

// The API surface is pure completions: even though `tools: []` removes every
// built-in tool, deny anything that somehow still asks.
const DENY_ALL_TOOLS: CanUseTool = async (toolName) => ({
  behavior: "deny",
  message: `yagami is a completions-only endpoint; tool "${toolName}" is disabled.`,
  interrupt: true,
});

interface RawStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface EngineOptions {
  /** Path to the `claude` binary. Auto-resolved when omitted. */
  claudePath?: string;
  /** Optional CLAUDE_CONFIG_DIR override for the spawned CLI. */
  claudeConfigDir?: string;
  /** Working directory for engine sessions (inert — tools are disabled). */
  workDir?: string;
  /** Model used when a request omits `model`. */
  defaultModel?: string;
  sessionCache?: SessionCache;
}

export interface CompleteResult {
  response: MessagesResponse;
  costUsd?: number;
  sessionId?: string;
  ignored: string[];
}

export interface StreamStart {
  ignored: string[];
  events: AsyncGenerator<SseEvent, void, undefined>;
}

interface PreparedQuery {
  prompt: string;
  options: Options;
  norm: NormalizedRequest;
  requestedModel: string;
}

/**
 * Translates Anthropic Messages API requests into Claude Agent SDK sessions
 * backed by the user's installed, signed-in Claude Code CLI.
 */
export class YagamiEngine {
  readonly claudePath: string;
  private readonly claudeConfigDir: string | undefined;
  private readonly workDir: string;
  private readonly defaultModel: string | undefined;
  private readonly cache: SessionCache;

  constructor(options: EngineOptions = {}) {
    this.claudePath = resolveClaudeExecutable(options.claudePath);
    this.claudeConfigDir = options.claudeConfigDir;
    this.defaultModel = options.defaultModel;
    this.cache = options.sessionCache ?? new SessionCache();
    // A fixed cwd for every session: keeps resume lookups consistent and
    // guarantees no real project directory is ever the session context.
    this.workDir = options.workDir ?? path.join(os.tmpdir(), "yagami-workspace");
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  private prepare(req: MessagesRequest): PreparedQuery {
    const norm = normalizeRequest(req);
    const model = req.model ?? this.defaultModel;
    if (!model || typeof model !== "string") {
      throw new ApiError(400, "invalid_request_error", "`model` is required (no defaultModel configured)");
    }

    let prompt = norm.lastUserText;
    let resume: string | undefined;
    if (norm.messages.length > 1) {
      resume = this.cache.get(prefixKey(norm.system, norm.messages.slice(0, -1)));
      if (!resume) prompt = flattenConversation(norm.messages);
    }

    const options: Options = {
      pathToClaudeCodeExecutable: this.claudePath,
      cwd: this.workDir,
      model,
      // Pure completions: no built-in tools, no settings/CLAUDE.md/skills
      // leaking in, exactly one assistant turn per request.
      tools: [],
      settingSources: [],
      maxTurns: 1,
      canUseTool: DENY_ALL_TOOLS,
      env: {
        ...process.env,
        ...(this.claudeConfigDir ? { CLAUDE_CONFIG_DIR: this.claudeConfigDir } : {}),
        CLAUDE_AGENT_SDK_CLIENT_APP: `yagami/${VERSION}`,
      },
    };
    if (norm.system !== undefined) options.systemPrompt = norm.system;
    if (resume) {
      options.resume = resume;
      // Fork so several conversation branches can share one cached prefix
      // without corrupting each other's transcripts.
      options.forkSession = true;
    }

    const thinking = mapThinking(req);
    if (thinking) options.thinking = thinking;
    if (typeof req.effort === "string") {
      if (!EFFORT_LEVELS.has(req.effort)) {
        throw new ApiError(400, "invalid_request_error", `invalid \`effort\`: ${req.effort}`);
      }
      options.effort = req.effort as EffortLevel;
    }

    return { prompt, options, norm, requestedModel: model };
  }

  private storeSession(norm: NormalizedRequest, assistantText: string, sessionId: string | undefined): void {
    if (!sessionId || !assistantText) return;
    const played = [...norm.messages, { role: "assistant" as const, text: assistantText }];
    this.cache.set(prefixKey(norm.system, played), sessionId);
  }

  async complete(req: MessagesRequest): Promise<CompleteResult> {
    const { prompt, options, norm, requestedModel } = this.prepare(req);

    let sessionId: string | undefined;
    let assistant: SDKAssistantMessage | undefined;
    let result: SDKResultMessage | undefined;

    try {
      for await (const msg of query({ prompt, options })) {
        if (msg.type === "system" && msg.subtype === "init") {
          sessionId = msg.session_id;
        } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
          assistant = msg;
        } else if (msg.type === "result") {
          result = msg;
          sessionId = msg.session_id;
        }
      }
    } catch (err) {
      throw toApiError(err);
    }

    if (!result) {
      throw new ApiError(500, "api_error", "Claude Code engine terminated without producing a result");
    }
    if (result.subtype !== "success") {
      const detail = "errors" in result && result.errors.length > 0 ? result.errors.join("; ") : result.subtype;
      throw new ApiError(500, "api_error", `Claude Code engine error: ${detail}`);
    }

    const raw = assistant?.message as
      | { id?: string; model?: string; content?: ContentBlock[]; stop_reason?: string | null }
      | undefined;
    let content = (raw?.content ?? []).filter((b) => b.type !== "tool_use");
    if (content.length === 0 && result.result) {
      content = [{ type: "text", text: result.result }];
    }
    const assistantText =
      content
        .filter((b) => b.type === "text")
        .map((b) => (typeof b["text"] === "string" ? (b["text"] as string) : ""))
        .join("") || result.result;

    this.storeSession(norm, assistantText, sessionId);

    const response: MessagesResponse = {
      id: raw?.id ?? `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model: raw?.model ?? requestedModel,
      content,
      stop_reason: raw?.stop_reason ?? "end_turn",
      stop_sequence: null,
      usage: mapUsage(result.usage as unknown as Record<string, unknown>),
    };

    return { response, costUsd: result.total_cost_usd, sessionId, ignored: norm.ignored };
  }

  /**
   * Validates synchronously (throws ApiError), then returns a lazy generator
   * of Anthropic-style SSE events.
   */
  stream(req: MessagesRequest, streamOptions: { signal?: AbortSignal } = {}): StreamStart {
    const prepared = this.prepare(req);
    return {
      ignored: prepared.norm.ignored,
      events: this.runStream(prepared, streamOptions.signal),
    };
  }

  private async *runStream(
    prepared: PreparedQuery,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SseEvent, void, undefined> {
    const { prompt, options, norm, requestedModel } = prepared;
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let sessionId: string | undefined;
    let assistantText = "";
    let sawStreamEvent = false;
    let stopped = false;
    let result: SDKResultMessage | undefined;

    try {
      const q = query({
        prompt,
        options: { ...options, abortController, includePartialMessages: true },
      });
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") {
          sessionId = msg.session_id;
        } else if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
          if (stopped) continue;
          const event = msg.event as unknown as RawStreamEvent;
          sawStreamEvent = true;
          if (event.type === "content_block_delta") {
            const delta = event["delta"] as { type?: string; text?: string } | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              assistantText += delta.text;
            }
          }
          yield { event: event.type, data: event };
          if (event.type === "message_stop") stopped = true;
        } else if (msg.type === "result") {
          result = msg;
          sessionId = msg.session_id;
        }
      }
    } catch (err) {
      if (!signal?.aborted) yield errorEvent(toApiError(err));
      return;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    if (signal?.aborted) return;

    if (!result || result.subtype !== "success") {
      const detail =
        result && "errors" in result && result.errors.length > 0
          ? result.errors.join("; ")
          : (result?.subtype ?? "engine terminated without a result");
      yield errorEvent(new ApiError(500, "api_error", `Claude Code engine error: ${detail}`));
      return;
    }

    // Some engine paths may not emit partial events; synthesize a valid
    // stream from the final result so clients always get a complete message.
    if (!sawStreamEvent) {
      assistantText = result.result;
      yield* synthesizeStream(result.result, requestedModel, mapUsage(result.usage as unknown as Record<string, unknown>));
    }

    this.storeSession(norm, assistantText || result.result, sessionId);
  }
}

function mapThinking(req: MessagesRequest): ThinkingConfig | undefined {
  const t = req.thinking;
  if (t == null) return undefined;
  if (t.type === "enabled") {
    return typeof t.budget_tokens === "number"
      ? { type: "enabled", budgetTokens: t.budget_tokens }
      : { type: "enabled" };
  }
  if (t.type === "disabled") return { type: "disabled" };
  if (t.type === "adaptive") return { type: "adaptive" };
  throw new ApiError(400, "invalid_request_error", `invalid \`thinking.type\`: ${String(t.type)}`);
}

function mapUsage(usage: Record<string, unknown>): Usage {
  const num = (key: string): number | undefined =>
    typeof usage[key] === "number" ? (usage[key] as number) : undefined;
  return {
    input_tokens: num("input_tokens") ?? 0,
    output_tokens: num("output_tokens") ?? 0,
    cache_creation_input_tokens: num("cache_creation_input_tokens") ?? 0,
    cache_read_input_tokens: num("cache_read_input_tokens") ?? 0,
  };
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError(500, "api_error", `Claude Code engine error: ${message}`);
}

function errorEvent(err: ApiError): SseEvent {
  return { event: "error", data: err.toBody() };
}

function* synthesizeStream(text: string, model: string, usage: Usage): Generator<SseEvent> {
  const id = `msg_${randomUUID().replace(/-/g, "")}`;
  yield {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    },
  };
  yield {
    event: "content_block_start",
    data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  };
  yield {
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  };
  yield { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } };
  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
  };
  yield { event: "message_stop", data: { type: "message_stop" } };
}
