import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderError, ProviderNotInstalledError, toApiError } from "./errors.js";
import type { EngineModel } from "./models.js";
import { parseModelRef, qualifiedModel, type Provider, type TurnEvent, type TurnRequest } from "./provider.js";
import { loadProviders, type ProviderConfigEntry } from "./providers/registry.js";
import { SessionCache } from "./sessionCache.js";
import { SseSynthesizer } from "./sse.js";
import {
  flattenConversation,
  normalizeRequest,
  prefillDirective,
  PrefillStripper,
  prefixKey,
  type NormalizedRequest,
} from "./transcript.js";
import { ApiError, type ContentBlock, type MessagesRequest, type MessagesResponse, type SseEvent } from "./types.js";

export type { EngineModel } from "./models.js";

const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
const THINKING_TYPES: ReadonlySet<string> = new Set(["enabled", "disabled", "adaptive"]);

export interface EngineOptions {
  /** Explicit provider instances (library mode). Overrides config-driven loading. */
  providers?: Provider[];
  /** Per-provider settings (`providers.<id>` in config.json). */
  providerConfig?: Record<string, ProviderConfigEntry>;
  /** Provider used for bare model ids (default: claude if installed, else the first available). */
  defaultProvider?: string;
  /** @deprecated Use providerConfig.claude.path. */
  claudePath?: string;
  /** @deprecated Use providerConfig.claude.configDir. */
  claudeConfigDir?: string;
  /** Working directory for completion turns (inert — tools are disabled/sandboxed). */
  workDir?: string;
  /** Model used when a request omits `model` (may be `provider:model`). */
  defaultModel?: string;
  sessionCache?: SessionCache;
  /** Reported to the CLIs as the client application name. */
  appName?: string;
}

export interface CompleteResult {
  response: MessagesResponse;
  costUsd?: number;
  sessionId?: string;
  provider: string;
  ignored: string[];
}

export interface StreamStart {
  ignored: string[];
  provider: string;
  events: AsyncGenerator<SseEvent, void, undefined>;
}

/** Metadata about a finished streaming turn, reported via `onResult`. */
export interface StreamResultInfo {
  costUsd?: number;
  sessionId?: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Called once when a streamed turn completes successfully. */
  onResult?: (info: StreamResultInfo) => void;
}

interface PreparedTurn {
  provider: Provider;
  turn: TurnRequest;
  norm: NormalizedRequest;
  /** Model id to report back (qualified unless it's the default provider's). */
  requestedModel: string;
  ignored: string[];
  /** Cache key the resume came from — set only when resuming a session. */
  resumeKey?: string;
}

/**
 * Translates Anthropic Messages API requests into turns on whichever
 * signed-in coding harness the model id names — Claude Code by default,
 * `codex:…`, `opencode:…`, `gemini:…` and friends on request.
 */
export class YagamiEngine {
  readonly providers: Map<string, Provider>;
  readonly unavailable: Map<string, string>;
  readonly defaultProviderId: string;
  private readonly defaultModel: string | undefined;
  private readonly cache: SessionCache;
  private readonly modelsPromises = new Map<string, Promise<EngineModel[]>>();

  constructor(options: EngineOptions = {}) {
    const workDir = options.workDir ?? path.join(os.tmpdir(), "yagami-workspace");
    fs.mkdirSync(workDir, { recursive: true });
    this.defaultModel = options.defaultModel;
    this.cache = options.sessionCache ?? new SessionCache();

    if (options.providers) {
      this.providers = new Map(options.providers.map((p) => [p.id, p]));
      this.unavailable = new Map();
    } else {
      const config: Record<string, ProviderConfigEntry> = { ...options.providerConfig };
      if (options.claudePath || options.claudeConfigDir) {
        config["claude"] = {
          ...config["claude"],
          ...(options.claudePath ? { path: options.claudePath } : {}),
          ...(options.claudeConfigDir ? { configDir: options.claudeConfigDir } : {}),
        };
      }
      const loaded = loadProviders(config, { workDir, ...(options.appName ? { appName: options.appName } : {}) });
      this.providers = loaded.providers;
      this.unavailable = loaded.unavailable;
    }

    const wanted = options.defaultProvider ?? (this.providers.has("claude") ? "claude" : [...this.providers.keys()][0]);
    if (!wanted || !this.providers.has(wanted)) {
      const reason = wanted ? this.unavailable.get(wanted) : "no supported coding-agent CLI was found on this machine";
      throw new ProviderNotInstalledError(wanted ?? "(none)", reason ?? "not installed");
    }
    this.defaultProviderId = wanted;
  }

  get defaultProvider(): Provider {
    return this.providers.get(this.defaultProviderId)!;
  }

  /** Executable of the default provider. */
  get executable(): string {
    return this.defaultProvider.executable;
  }

  /** @deprecated Use `executable`. */
  get claudePath(): string {
    return this.executable;
  }

  get providerIds(): string[] {
    return [...this.providers.keys()];
  }

  /** Route a request's model id to a provider and its native model. */
  resolve(model: string | undefined): { provider: Provider; model?: string } {
    const ref = parseModelRef(model ?? this.defaultModel, this.providers.keys());
    if (ref.providerId && !this.providers.has(ref.providerId)) {
      throw new ApiError(503, "api_error", `provider "${ref.providerId}" is not available: ${this.unavailable.get(ref.providerId) ?? "not installed"}`);
    }
    const provider = this.providers.get(ref.providerId ?? this.defaultProviderId)!;
    return ref.model ? { provider, model: ref.model } : { provider };
  }

  /**
   * Models across every available provider. The default provider's ids are
   * listed bare as well as qualified; others only as `provider:model`.
   * Providers whose probe fails are skipped (their error is not cached).
   */
  async listModels(): Promise<EngineModel[]> {
    const out: EngineModel[] = [];
    const entries = await Promise.all(
      [...this.providers.entries()].map(async ([id, provider]) => {
        try {
          return [id, await this.providerModels(id, provider)] as const;
        } catch {
          return [id, []] as const;
        }
      }),
    );
    for (const [id, models] of entries) {
      for (const m of models) {
        if (id === this.defaultProviderId) out.push({ ...m, provider: id });
        out.push({ ...m, id: qualifiedModel(id, m.id), provider: id });
      }
    }
    return out;
  }

  private providerModels(id: string, provider: Provider): Promise<EngineModel[]> {
    let promise = this.modelsPromises.get(id);
    if (!promise) {
      promise = provider.listModels().catch((err) => {
        this.modelsPromises.delete(id);
        throw err;
      });
      this.modelsPromises.set(id, promise);
    }
    return promise;
  }

  private prepare(req: MessagesRequest, opts: { skipResume?: boolean } = {}): PreparedTurn {
    const norm = normalizeRequest(req);
    const { provider, model } = this.resolve(req.model);
    const caps = provider.capabilities;
    const ignored = [...norm.ignored];

    if (req.thinking != null) {
      if (!THINKING_TYPES.has(String(req.thinking.type))) {
        throw new ApiError(400, "invalid_request_error", `invalid \`thinking.type\`: ${String(req.thinking.type)}`);
      }
      if (!caps.thinking) ignored.push("thinking");
    }
    if (req.effort != null) {
      if (typeof req.effort !== "string" || !EFFORT_LEVELS.has(req.effort)) {
        throw new ApiError(400, "invalid_request_error", `invalid \`effort\`: ${String(req.effort)}`);
      }
      if (!caps.effort) ignored.push("effort");
    }

    const last = norm.messages[norm.messages.length - 1]!;
    const lastMedia = last.media ?? [];
    if (lastMedia.some((b) => b.type === "image") && !caps.images) {
      throw new ApiError(400, "invalid_request_error", `provider "${provider.id}" does not accept image blocks`);
    }
    if (lastMedia.some((b) => b.type === "document") && !caps.documents) {
      throw new ApiError(400, "invalid_request_error", `provider "${provider.id}" does not accept document blocks`);
    }

    let promptText = norm.lastUserText;
    let resume: string | undefined;
    let resumeKey: string | undefined;
    if (norm.messages.length > 1) {
      const history = norm.messages.slice(0, -1);
      if (caps.resume && !opts.skipResume) {
        resumeKey = prefixKey(norm.system, history, provider.id);
        resume = this.cache.get(resumeKey);
        // Without fork support a resumed session is spent: the mapping must
        // not be reused by a sibling branch, which would corrupt both.
        if (resume && !caps.fork) this.cache.delete(resumeKey);
      }
      if (!resume) {
        // Media in the history can't be replayed as text; only a live cached
        // session (which already holds those blocks) can continue from here.
        if (history.some((m) => m.media && m.media.length > 0)) {
          throw new ApiError(
            400,
            "invalid_request_error",
            "conversation history contains image/document blocks and no cached session matches this prefix; yagami can only replay text history. Continue such conversations against the server that produced them.",
          );
        }
        promptText = flattenConversation(norm.messages);
      }
    }
    if (norm.prefill) promptText = `${promptText}\n\n${prefillDirective(norm.prefill)}`;
    if (norm.system !== undefined && !caps.systemPrompt) {
      promptText = `<system>\n${norm.system}\n</system>\n\n${promptText}`;
    }

    const turn: TurnRequest = {
      prompt: promptText,
      ...(lastMedia.length > 0 ? { media: lastMedia } : {}),
      ...(norm.system !== undefined && caps.systemPrompt ? { system: norm.system } : {}),
      ...(model ? { model } : {}),
      ...(resume ? { resume } : {}),
      ...(req.thinking != null && caps.thinking ? { thinking: req.thinking } : {}),
      ...(typeof req.effort === "string" && caps.effort ? { effort: req.effort } : {}),
    };
    const requestedModel = model
      ? provider.id === this.defaultProviderId
        ? model
        : qualifiedModel(provider.id, model)
      : provider.id;

    return { provider, turn, norm, requestedModel, ignored, ...(resume && resumeKey ? { resumeKey } : {}) };
  }

  /**
   * A failed resumed attempt usually means the cached session no longer
   * exists. Drop the stale mapping and re-prepare from scratch — the
   * transcript-replay path. Undefined when falling back is impossible.
   */
  private prepareResumeFallback(req: MessagesRequest, failed: PreparedTurn): PreparedTurn | undefined {
    if (!failed.resumeKey) return undefined;
    this.cache.delete(failed.resumeKey);
    try {
      return this.prepare(req, { skipResume: true });
    } catch {
      return undefined;
    }
  }

  private storeSession(prepared: PreparedTurn, continuation: string, sessionId: string | undefined): void {
    const { norm, provider } = prepared;
    // Clients replay prefill + continuation as one assistant message, so the
    // stored prefix must record the full text, not just what we returned.
    const fullText = (norm.prefill ?? "") + continuation;
    if (!sessionId || !fullText || !provider.capabilities.resume) return;
    const played = [...norm.messages, { role: "assistant" as const, text: fullText }];
    this.cache.set(prefixKey(norm.system, played, provider.id), sessionId);
  }

  async complete(req: MessagesRequest): Promise<CompleteResult> {
    const prepared = this.prepare(req);
    try {
      return await this.attemptComplete(prepared);
    } catch (err) {
      const fallback = this.prepareResumeFallback(req, prepared);
      if (!fallback) throw toApiError(err);
      try {
        return await this.attemptComplete(fallback);
      } catch (err2) {
        throw toApiError(err2);
      }
    }
  }

  private async attemptComplete(prepared: PreparedTurn): Promise<CompleteResult> {
    const { provider, turn, norm, requestedModel, ignored } = prepared;
    const stripper = norm.prefill ? new PrefillStripper(norm.prefill) : undefined;
    let sessionId: string | undefined;
    let text = "";
    let thinking = "";
    let done: Extract<TurnEvent, { type: "done" }> | undefined;

    for await (const ev of provider.run(turn)) {
      if (ev.type === "session") sessionId = ev.sessionId;
      else if (ev.type === "text") text += stripper ? stripper.push(ev.text) : ev.text;
      else if (ev.type === "thinking") thinking += ev.text;
      else done = ev;
    }
    if (stripper) text += stripper.flush();
    if (!done) throw new ProviderError(provider.id, "turn ended without a result");

    this.storeSession(prepared, text, sessionId);

    const content: ContentBlock[] = [
      ...(thinking ? [{ type: "thinking", thinking, signature: "" }] : []),
      { type: "text", text },
    ];
    const response: MessagesResponse = {
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model: done.model ?? requestedModel,
      content,
      stop_reason: done.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: done.usage,
    };
    return {
      response,
      ...(done.costUsd !== undefined ? { costUsd: done.costUsd } : {}),
      ...(sessionId ? { sessionId } : {}),
      provider: provider.id,
      ignored,
    };
  }

  /**
   * Validates synchronously (throws ApiError), then returns a lazy generator
   * of Anthropic-style SSE events.
   */
  stream(req: MessagesRequest, streamOptions: StreamOptions = {}): StreamStart {
    const prepared = this.prepare(req);
    return {
      ignored: prepared.ignored,
      provider: prepared.provider.id,
      events: this.runStream(req, prepared, streamOptions),
    };
  }

  private async *runStream(
    req: MessagesRequest,
    prepared: PreparedTurn,
    streamOptions: StreamOptions,
  ): AsyncGenerator<SseEvent, void, undefined> {
    const { signal } = streamOptions;
    let emitted = false;
    try {
      for await (const ev of this.attemptStream(prepared, streamOptions)) {
        emitted = true;
        yield ev;
      }
      return;
    } catch (err) {
      if (signal?.aborted) return;
      // A resumed session that died before emitting anything can be retried
      // transparently against a fresh session (transcript replay).
      const fallback = emitted ? undefined : this.prepareResumeFallback(req, prepared);
      if (!fallback) {
        yield { event: "error", data: toApiError(err).toBody() };
        return;
      }
      try {
        yield* this.attemptStream(fallback, streamOptions);
      } catch (err2) {
        if (!signal?.aborted) yield { event: "error", data: toApiError(err2).toBody() };
      }
    }
  }

  private async *attemptStream(
    prepared: PreparedTurn,
    streamOptions: StreamOptions,
  ): AsyncGenerator<SseEvent, void, undefined> {
    const { provider, turn, norm, requestedModel } = prepared;
    const { signal } = streamOptions;
    const stripper = norm.prefill ? new PrefillStripper(norm.prefill) : undefined;
    const sse = new SseSynthesizer(`msg_${randomUUID().replace(/-/g, "")}`, requestedModel);
    let sessionId: string | undefined;
    let text = "";
    let done: Extract<TurnEvent, { type: "done" }> | undefined;
    // The envelope is sent with the first content event, not up front, so a
    // resumed session that dies before producing anything can still be
    // retried transparently (nothing has reached the client yet).
    let started = false;
    const start = (): SseEvent[] => {
      if (started) return [];
      started = true;
      return sse.start();
    };

    for await (const ev of provider.run({ ...turn, ...(signal ? { signal } : {}) })) {
      if (ev.type === "session") {
        sessionId = ev.sessionId;
      } else if (ev.type === "text") {
        const out = stripper ? stripper.push(ev.text) : ev.text;
        text += out;
        yield* start();
        yield* sse.text(out);
      } else if (ev.type === "thinking") {
        yield* start();
        yield* sse.thinking(ev.text);
      } else {
        done = ev;
      }
    }
    if (signal?.aborted) return;
    if (!done) throw new ProviderError(provider.id, "turn ended without a result");
    yield* start();
    if (stripper) {
      const held = stripper.flush();
      text += held;
      yield* sse.text(held);
    }
    yield* sse.finish(done.usage, done.stopReason ?? "end_turn");

    this.storeSession(prepared, text, sessionId);
    streamOptions.onResult?.({
      ...(done.costUsd !== undefined ? { costUsd: done.costUsd } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
  }
}
