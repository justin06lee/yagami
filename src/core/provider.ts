import type { ContentBlockParam, ThinkingParam, Usage } from "./types.js";
import type { EngineModel } from "./models.js";

/** What a provider can natively honor; the engine emulates or rejects the rest. */
export interface ProviderCapabilities {
  /** Can continue a previous session by id (otherwise history is replayed as text). */
  resume: boolean;
  /** Resuming leaves the original session intact (branches are safe). */
  fork: boolean;
  images: boolean;
  documents: boolean;
  systemPrompt: boolean;
  thinking: boolean;
  effort: boolean;
  /** Token-level deltas or whole chunks per message part. */
  streaming: "tokens" | "chunks";
}

/** One completion turn, already normalized by the engine. */
export interface TurnRequest {
  /** Full prompt text (history already flattened, prefill directive appended). */
  prompt: string;
  /** Image/document blocks (Anthropic shape) attached to the prompt. */
  media?: ContentBlockParam[];
  system?: string;
  /** Provider-native model id; undefined means the provider's own default. */
  model?: string;
  /** Provider session id to continue. */
  resume?: string;
  thinking?: ThinkingParam;
  effort?: string;
  signal?: AbortSignal;
}

export type TurnEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "done";
      usage: Usage;
      costUsd?: number;
      model?: string;
      stopReason?: string;
    };

/**
 * A coding-agent harness yagami can drive: a signed-in CLI on this machine,
 * wrapped so the engine can run sandboxed completion turns through it.
 */
export interface Provider {
  readonly id: string;
  readonly label: string;
  /** Resolved path of the CLI binary (for diagnostics). */
  readonly executable: string;
  readonly capabilities: ProviderCapabilities;
  /** Shell command that signs the CLI in, for error messages. */
  readonly loginCommand: string;
  /** Run one sandboxed completion turn. Throws typed errors on failure. */
  run(req: TurnRequest): AsyncGenerator<TurnEvent, void, undefined>;
  /** Models the CLI reports as available (may spawn a short-lived process). */
  listModels(): Promise<EngineModel[]>;
  /** CLI version string, if it can be determined. */
  version(): Promise<string | undefined>;
}

export interface ModelRef {
  providerId?: string;
  model?: string;
}

/**
 * Split a request's `model` into provider + native model. `"codex:gpt-5"`
 * routes to codex; a bare provider id (`"codex"`) means that provider's
 * default model; anything else is a model for the default provider. The
 * split happens only at the first colon and only when the prefix names a
 * known provider, so ids like `"ollama/llama3:8b"` stay intact.
 */
export function parseModelRef(model: string | undefined, providerIds: Iterable<string>): ModelRef {
  if (!model) return {};
  const ids = new Set(providerIds);
  if (ids.has(model)) return { providerId: model };
  const colon = model.indexOf(":");
  if (colon > 0) {
    const prefix = model.slice(0, colon);
    if (ids.has(prefix)) {
      const rest = model.slice(colon + 1);
      return rest ? { providerId: prefix, model: rest } : { providerId: prefix };
    }
  }
  return { model };
}

export function qualifiedModel(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}
