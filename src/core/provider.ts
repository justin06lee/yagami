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
  /**
   * Can run Anthropic server tools (web search/fetch) inside the turn. Still
   * completions-only: results are folded into the reply, never emitted as
   * `tool_use` blocks for the caller to execute.
   */
  serverTools: boolean;
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
  /** CLI tool names to enable for this turn (see `core/serverTools.ts`). */
  serverTools?: string[];
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

// ---------------------------------------------------------------------------
// Agentic sessions (library mode): tools, permissions, the works.
// ---------------------------------------------------------------------------

export type SessionPermissionDecision = "allow" | "allow_always" | "deny" | "deny_always";

export type SessionInputValue = string | number | boolean | string[];

export interface SessionInputOption {
  value: string;
  label: string;
  description?: string;
}

/** One renderable field from a harness question or MCP elicitation. */
export interface SessionInputField {
  id: string;
  label: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean" | "select" | "multiselect";
  required: boolean;
  secret?: boolean;
  allowOther?: boolean;
  options?: SessionInputOption[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: SessionInputValue;
}

/** A provider-neutral blocking request for human input. */
export interface SessionInputRequest {
  provider: string;
  sessionId?: string;
  kind: "questions" | "form" | "url";
  message: string;
  source?: string;
  fields?: SessionInputField[];
  url?: string;
  blocking?: boolean;
  raw?: unknown;
}

export type SessionInputResponse =
  | { action: "accept"; values?: Record<string, SessionInputValue> }
  | { action: "decline" | "cancel" };

export interface SessionInputHandler {
  respond(req: SessionInputRequest, signal?: AbortSignal): Promise<SessionInputResponse>;
}

export type SessionPlanStatus = "pending" | "in_progress" | "completed";

export interface SessionPlanEntry {
  content: string;
  status: SessionPlanStatus;
  priority?: "high" | "medium" | "low";
}

export interface SessionPlan {
  id?: string;
  explanation?: string;
  entries?: SessionPlanEntry[];
  markdown?: string;
  uri?: string;
  removed?: boolean;
}

/** A harness asking the host whether a tool may run. */
export interface SessionPermissionRequest {
  provider: string;
  sessionId?: string;
  /** Tool name as the harness calls it (e.g. "Bash", "Edit", or an ACP title). */
  tool: string;
  /** Coarse category when known: read | edit | delete | execute | fetch | other … */
  kind?: string;
  title?: string;
  input?: unknown;
  /** Provider-native payload for hosts that want to go deep. */
  raw?: unknown;
}

export interface SessionPermissionHandler {
  decide(req: SessionPermissionRequest, signal?: AbortSignal): Promise<SessionPermissionDecision>;
}

export type AgentEvent =
  | { type: "session"; sessionId: string }
  /** Provider-native turn id, used by hosts to fork an exact exchange. */
  | { type: "turn"; id: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      status: "started" | "updated" | "completed" | "failed";
      title?: string;
      kind?: string;
      input?: unknown;
      output?: unknown;
    }
  | { type: "permission"; request: SessionPermissionRequest; decision: SessionPermissionDecision }
  | { type: "plan"; plan: SessionPlan }
  | { type: "done"; usage?: Usage; costUsd?: number; stopReason?: string }
  /** Anything the harness said that has no normalized shape. */
  | { type: "raw"; provider: string; payload: unknown };

export interface ProviderSessionOptions {
  /** Project directory the agent works in. */
  cwd: string;
  model?: string;
  /** Provider session id to continue. */
  resume?: string;
  /** Fork the resumed session instead of continuing it in place. */
  fork?: boolean;
  /** Fork the resumed session through this provider-native turn, inclusive. */
  forkAt?: string;
  /**
   * "terminal" loads the same settings the interactive CLI would — user and
   * project config, CLAUDE.md, skills, hooks, MCP servers. "isolated" loads
   * none of it. Default "terminal", because that is the promise.
   */
  parity?: "terminal" | "isolated";
  permissions: SessionPermissionHandler;
  /** Blocking questions and MCP/ACP elicitations. Omitted means decline safely. */
  input?: SessionInputHandler;
  appName?: string;
  effort?: string;
  thinking?: ThinkingParam;
  /** Override the harness's interactive system prompt. */
  systemPrompt?: string;
  /** Provider-specific escape hatch (Claude: Agent SDK Options; Codex: { sandbox }; ACP: { mode }). */
  native?: Record<string, unknown>;
}

export interface ProviderSessionCapabilities {
  /** Can fork a resumed conversation, optionally at an exact reported turn. */
  fork: boolean;
}

/** One live conversation with a harness: send turns, get normalized events. */
export interface ProviderSession {
  readonly provider: string;
  /** Provider session id once known (use it to resume later). */
  readonly id: string | undefined;
  send(input: string | ContentBlockParam[]): AsyncGenerator<AgentEvent, void, undefined>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** Providers that can host agentic sessions implement this too. */
export interface SessionProvider extends Provider {
  readonly sessionCapabilities: ProviderSessionCapabilities;
  openSession(options: ProviderSessionOptions): ProviderSession;
}

export function isSessionProvider(p: Provider): p is SessionProvider {
  return typeof (p as Partial<SessionProvider>).openSession === "function";
}
