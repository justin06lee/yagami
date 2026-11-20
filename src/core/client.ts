/**
 * `Yagami` — the zero-config library client. `new Yagami()` needs no URL and
 * no API key: it finds the coding-agent CLIs already installed and signed in
 * on this machine (the same T3-Code trick the server does) and mirrors the
 * Anthropic and OpenAI SDK surfaces on top of them, so an app written
 * against either SDK shape drops in with nothing to configure.
 *
 * By default it also reads the host's yagami config
 * (~/.config/yagami/config.json), so an embedded client and the `yagami`
 * binary on the same machine agree on providers, paths, and defaults.
 */

import { YagamiEngine, type EngineOptions } from "./engine.js";
import { YagamiError } from "./errors.js";
import type { Harness } from "./harnesses.js";
import { loadHostEngineConfig } from "./hostConfig.js";
import { ApiError, type ContentBlockParam, type MessagesRequest, type MessagesResponse, type SseEvent } from "./types.js";
import type { EngineModel } from "./models.js";
import type { PlanLimit, PlanUsage } from "./provider.js";
import {
  ChatChunkTranslator,
  chatToMessagesRequest,
  modelListBody,
  toChatCompletion,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionsRequest,
} from "./openai.js";

export interface YagamiOptions extends EngineOptions {
  /**
   * Merge the host machine's yagami config (providers, defaults) under any
   * explicit options, so library and binary stay in sync. Default true;
   * ignored when explicit `providers` instances are passed.
   */
  syncHostConfig?: boolean;
}

/** An Anthropic stream event's payload (`message_start`, `content_block_delta`, …). */
export interface MessageStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface YagamiMessages {
  /** Anthropic-SDK-shaped: non-stream resolves to the message; `stream: true` yields stream events. */
  create(req: MessagesRequest & { stream: true }): AsyncGenerator<MessageStreamEvent, void, undefined>;
  create(req: MessagesRequest & { stream?: false | undefined }): Promise<MessagesResponse>;
  /** Always-streaming variant (the SDK's `messages.stream`). */
  stream(req: MessagesRequest): AsyncGenerator<MessageStreamEvent, void, undefined>;
}

export interface YagamiChatCompletions {
  /** OpenAI-SDK-shaped: non-stream resolves to a chat.completion; `stream: true` yields chunks. */
  create(req: ChatCompletionsRequest & { stream: true }): AsyncGenerator<ChatCompletionChunk, void, undefined>;
  create(req: ChatCompletionsRequest & { stream?: false | undefined }): Promise<ChatCompletion>;
}

/** One read-only completion turn on one harness. */
export interface TurnOptions {
  /** Harness id as `harnesses()` lists it. Omitted: the default harness. */
  harness?: string;
  /** The harness's own model id, as `models.for()` lists it. Omitted: the harness's default. */
  model?: string;
  system?: string;
  text: string;
  /** Images to look at, base64-encoded. `mediaType` defaults to image/png. */
  images?: Array<{ data: string; mediaType?: string }>;
  /** Let the harness search the web first, where it can (see `ignored`). */
  webSearch?: boolean;
  /** Reasoning effort: "low" … "max", or a level the model lists. */
  effort?: string;
  signal?: AbortSignal;
  /** Reply text as it arrives. The result still carries all of it. */
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
}

export interface TurnResult {
  text: string;
  /** The model's visible reasoning, when the harness streams any. */
  thinking?: string;
  harness: string;
  /** The model that answered, as the harness names it. */
  model: string;
  /**
   * Token counts as the harness reports them (all zero where it reports
   * none). On Claude Code `input` leaves out what was read from or written
   * to the prompt cache; those are `cacheRead` and `cacheWrite`.
   */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number;
  /** Context size of the model that answered, where the harness reports it. */
  contextWindow?: number;
  /** The plan's usage windows as reported during the turn (Claude Code). */
  limits?: PlanLimit[];
  stopReason: string;
  /** What this harness could not honour and ran without: "webSearch", "effort", "thinking". */
  ignored: string[];
}

export class Yagami {
  /** The underlying engine, for anything beyond the SDK-shaped surface. */
  readonly engine: YagamiEngine;

  constructor(options: YagamiOptions = {}) {
    const { syncHostConfig, ...engineOptions } = options;
    const host = syncHostConfig === false || engineOptions.providers ? {} : loadHostEngineConfig();
    this.engine = new YagamiEngine({ ...host, ...definedProps(engineOptions) });
  }

  readonly messages: YagamiMessages = (() => {
    const streamEvents = (req: MessagesRequest) => this.streamMessageEvents(req);
    const complete = async (req: MessagesRequest) => (await this.engine.complete(req)).response;
    function create(req: MessagesRequest & { stream: true }): AsyncGenerator<MessageStreamEvent, void, undefined>;
    function create(req: MessagesRequest & { stream?: false | undefined }): Promise<MessagesResponse>;
    function create(req: MessagesRequest): unknown {
      return req.stream === true ? streamEvents(req) : complete(req);
    }
    return { create, stream: streamEvents };
  })();

  readonly chat: { completions: YagamiChatCompletions } = (() => {
    const streamChunks = (req: ChatCompletionsRequest) => this.streamChatChunks(req);
    const complete = async (req: ChatCompletionsRequest) => {
      const { req: translated } = chatToMessagesRequest(req);
      return toChatCompletion((await this.engine.complete(translated)).response);
    };
    function create(req: ChatCompletionsRequest & { stream: true }): AsyncGenerator<ChatCompletionChunk, void, undefined>;
    function create(req: ChatCompletionsRequest & { stream?: false | undefined }): Promise<ChatCompletion>;
    function create(req: ChatCompletionsRequest): unknown {
      return req.stream === true ? streamChunks(req) : complete(req);
    }
    return { completions: { create } };
  })();

  readonly models = {
    /** Both SDK shapes at once (Anthropic + OpenAI model-list fields). */
    list: async (): Promise<ReturnType<typeof modelListBody>> => modelListBody(await this.engine.listModels()),
    /** The engine's raw model list. */
    raw: (): Promise<EngineModel[]> => this.engine.listModels(),
    /**
     * One harness's models in its own ids, the default first, each with its
     * `context_window` where the harness reports one. Rejects with the typed
     * failure (`AuthRequiredError`, `ProviderNotInstalledError`, …).
     */
    for: (harness: string, options: { refresh?: boolean } = {}): Promise<EngineModel[]> =>
      this.engine.harnessModels(harness, options),
  };

  /**
   * Every harness yagami knows, installed or not: whether it is installed
   * and signed in, a human label, and what to run when it isn't. Starts each
   * installed CLI briefly to ask; no model is called. `status: false` skips
   * the sign-in checks.
   */
  harnesses(options: { status?: boolean } = {}): Promise<Harness[]> {
    return this.engine.harnesses(options);
  }

  /**
   * A harness's plan usage right now, without a model call (Claude Code's
   * five-hour and seven-day windows). Undefined where the harness can't say.
   */
  limits(harness?: string): Promise<PlanUsage | undefined> {
    return this.engine.limits(harness);
  }

  /**
   * One completion turn: system prompt, text and optional images in, text
   * and token counts out. The harness runs read-only in a throwaway
   * directory, as every yagami completion does. Rejects with the typed
   * failure — `UsageLimitError` for a used-up plan (with `resetsAt`),
   * `AuthRequiredError`, `ProviderNotInstalledError`, `ProviderError` — or
   * an `ApiError` for a request the harness cannot take (images on one that
   * reads none).
   */
  async turn(options: TurnOptions): Promise<TurnResult> {
    const ref = options.harness ? (options.model ? `${options.harness}:${options.model}` : options.harness) : options.model;
    // a named harness is that harness or a failure: a model id would otherwise
    // let a harness that isn't there fall through to the default one
    const caps = (options.harness ? this.engine.harness(options.harness) : this.engine.resolve(ref).provider).capabilities;
    const content: ContentBlockParam[] = [
      ...(options.images ?? []).map((image) => ({
        type: "image",
        source: { type: "base64", media_type: image.mediaType ?? "image/png", data: image.data },
      })),
      { type: "text", text: options.text },
    ];
    const search = options.webSearch === true && caps.serverTools;
    const req: MessagesRequest = {
      ...(ref ? { model: ref } : {}),
      messages: [{ role: "user", content }],
      ...(options.system !== undefined ? { system: options.system } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(search ? { tools: [{ type: "web_search_20260209", name: "web_search" }] } : {}),
    };
    let thinking = "";
    try {
      const result = await this.engine.complete(req, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onText ? { onText: options.onText } : {}),
        onThinking: (delta) => {
          thinking += delta;
          options.onThinking?.(delta);
        },
      });
      const { response } = result;
      return {
        text: response.content.filter((b) => b.type === "text").map((b) => String(b["text"])).join(""),
        ...(thinking ? { thinking } : {}),
        harness: result.provider,
        // the engine qualifies another harness's model as "harness:model"; here the harness is its own field
        model: response.model.startsWith(`${result.provider}:`) ? response.model.slice(result.provider.length + 1) : response.model,
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          cacheRead: response.usage.cache_read_input_tokens ?? 0,
          cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
        },
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        ...(result.contextWindow ? { contextWindow: result.contextWindow } : {}),
        ...(result.limits ? { limits: result.limits } : {}),
        stopReason: response.stop_reason ?? "end_turn",
        ignored: [...result.ignored, ...(options.webSearch === true && !search ? ["webSearch"] : [])],
      };
    } catch (err) {
      if (options.signal?.aborted) throw new DOMException("the turn was aborted", "AbortError");
      throw typedFailure(err);
    }
  }

  private async *streamMessageEvents(req: MessagesRequest): AsyncGenerator<MessageStreamEvent, void, undefined> {
    const { events } = this.engine.stream(req);
    for await (const ev of events) {
      if (ev.event === "error") throw errorFromEvent(ev);
      yield ev.data as MessageStreamEvent;
    }
  }

  private async *streamChatChunks(req: ChatCompletionsRequest): AsyncGenerator<ChatCompletionChunk, void, undefined> {
    const { req: translated, includeUsage } = chatToMessagesRequest({ ...req, stream: true });
    const translator = new ChatChunkTranslator(includeUsage);
    const { events } = this.engine.stream(translated);
    for await (const ev of events) {
      if (ev.event === "error") throw errorFromEvent(ev);
      for (const chunk of translator.push(ev)) yield chunk as ChatCompletionChunk;
    }
  }
}

/** The engine's own ApiError (status and typed cause intact), else one rebuilt from the body. */
function errorFromEvent(ev: SseEvent): ApiError {
  if (ev.error) return ev.error;
  const error = (ev.data as { error?: { type?: string; message?: string } } | undefined)?.error;
  return new ApiError(500, (error?.type as ApiError["type"]) ?? "api_error", error?.message ?? "stream error");
}

/** The typed yagami failure behind an engine error, when there is one. */
function typedFailure(err: unknown): unknown {
  const cause = err instanceof ApiError ? err.cause : undefined;
  return cause instanceof YagamiError ? cause : err;
}

function definedProps<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
