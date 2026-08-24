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
import { loadHostEngineConfig } from "./hostConfig.js";
import { ApiError, type MessagesRequest, type MessagesResponse } from "./types.js";
import type { EngineModel } from "./models.js";
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
  };

  private async *streamMessageEvents(req: MessagesRequest): AsyncGenerator<MessageStreamEvent, void, undefined> {
    const { events } = this.engine.stream(req);
    for await (const ev of events) {
      if (ev.event === "error") throw errorFromEvent(ev.data);
      yield ev.data as MessageStreamEvent;
    }
  }

  private async *streamChatChunks(req: ChatCompletionsRequest): AsyncGenerator<ChatCompletionChunk, void, undefined> {
    const { req: translated, includeUsage } = chatToMessagesRequest({ ...req, stream: true });
    const translator = new ChatChunkTranslator(includeUsage);
    const { events } = this.engine.stream(translated);
    for await (const ev of events) {
      if (ev.event === "error") throw errorFromEvent(ev.data);
      for (const chunk of translator.push(ev)) yield chunk as ChatCompletionChunk;
    }
  }
}

function errorFromEvent(data: unknown): ApiError {
  const error = (data as { error?: { type?: string; message?: string } } | undefined)?.error;
  return new ApiError(500, (error?.type as ApiError["type"]) ?? "api_error", error?.message ?? "stream error");
}

function definedProps<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
