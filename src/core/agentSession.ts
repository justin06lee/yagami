import {
  query,
  type Options,
  type Query,
  type RewindFilesResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExecutable } from "./executable.js";
import { classifyProviderFailure } from "./errors.js";
import { settingSourcesFor, type Parity } from "./parity.js";
import { PermissionAdapter, type PermissionHandler, type PermissionAdapterOptions } from "./permission.js";
import { AsyncQueue } from "./providers/queue.js";
import { VERSION } from "../version.js";

export interface AgentSessionOptions {
  /** Path to the `claude` binary. Auto-resolved when omitted. */
  claudePath?: string;
  /** Project directory the agent works in. */
  cwd?: string;
  /** How closely to mirror the interactive terminal (default "terminal"). */
  parity?: Parity;
  /** Model id/alias; the CLI default when omitted. */
  model?: string;
  /** Host permission callback (see {@link PermissionAdapter}). */
  onPermission?: PermissionHandler;
  /** Options for the permission adapter (fallback, auto-allow/deny). */
  permission?: PermissionAdapterOptions;
  /** Reported to the CLI as the client application (e.g. your app name). */
  appName?: string;
  /** Extra Agent SDK options, merged last (wins over the above). */
  options?: Options;
}

/**
 * A long-lived, agentic Claude Code session for building a UI on top of the
 * CLI — the ruri use case. It keeps one warm process across turns (so only
 * the first turn pays cold-start), threads permission decisions to a host
 * callback, mirrors your terminal settings by default, and exposes the
 * lifecycle the interactive CLI gives you for free: send, interrupt, resume,
 * change model/permission mode, close.
 *
 * Everything the model produces is an {@link SDKMessage} you render yourself.
 */
export class AgentSession implements AsyncIterable<SDKMessage> {
  readonly permissions: PermissionAdapter;
  private readonly claudePath: string;
  private readonly appName: string;
  private readonly baseOptions: Options;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private query: Query | undefined;
  private started = false;
  private closed = false;
  private currentSessionId: string | undefined;

  constructor(options: AgentSessionOptions = {}) {
    this.claudePath = resolveClaudeExecutable(options.claudePath ?? options.options?.pathToClaudeCodeExecutable);
    this.appName = options.appName ?? "yagami";
    this.permissions = new PermissionAdapter(options.permission ?? {});
    if (options.onPermission) this.permissions.setHandler(options.onPermission);
    this.baseOptions = {
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: settingSourcesFor(options.parity ?? "terminal"),
      includePartialMessages: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...options.options,
      canUseTool: options.options?.canUseTool ?? this.permissions.canUseTool,
      pathToClaudeCodeExecutable: this.claudePath,
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: `${this.appName}/${VERSION}`,
        ...options.options?.env,
      },
    };
  }

  /** Set (or clear) the host permission callback after construction. */
  setPermissionHandler(handler: PermissionHandler | undefined): void {
    this.permissions.setHandler(handler);
  }

  /** The live Claude Code session id, once the first turn has started. */
  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  /** Queue a user turn. The process starts on the first send and stays warm. */
  send(text: string, options: { images?: Array<{ data: string; mediaType?: string }> } = {}): void {
    if (this.closed) throw new Error("session is closed");
    const content =
      options.images && options.images.length > 0
        ? [
            ...options.images.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType ?? "image/png", data: img.data } })),
            { type: "text" as const, text },
          ]
        : text;
    this.input.push({
      type: "user",
      message: { role: "user", content } as SDKUserMessage["message"],
      parent_tool_use_id: null,
      session_id: this.currentSessionId ?? "",
    } as SDKUserMessage);
    this.ensureStarted();
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.query = query({ prompt: this.input, options: this.baseOptions });
  }

  /** Iterate every SDK message the agent produces across all turns. */
  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    this.ensureStarted();
    try {
      for await (const msg of this.query!) {
        if (msg.type === "system" && msg.subtype === "init") this.currentSessionId = msg.session_id;
        else if (msg.type === "result") this.currentSessionId = msg.session_id;
        yield msg;
      }
    } catch (err) {
      throw classifyProviderFailure("claude", "claude (then /login)", err);
    }
  }

  /** Interrupt the in-flight turn (the CLI's Esc/Ctrl-C). */
  async interrupt(): Promise<void> {
    await this.query?.interrupt();
  }

  /** Switch models mid-session (the CLI's /model). */
  async setModel(model: string): Promise<void> {
    await this.query?.setModel(model);
  }

  /** Switch permission mode mid-session (default/acceptEdits/plan/bypassPermissions). */
  async setPermissionMode(mode: "default" | "acceptEdits" | "plan" | "bypassPermissions"): Promise<void> {
    await this.query?.setPermissionMode(mode);
  }

  /** Models the CLI reports as available (for a picker). */
  async supportedModels(): Promise<Array<{ value: string; displayName: string }>> {
    this.ensureStarted();
    const models = await this.query!.supportedModels();
    return models.map((m) => ({ value: m.value, displayName: m.displayName }));
  }

  /**
   * Rewind tracked files to their state at a user message (the CLI's
   * /rewind). Needs `enableFileCheckpointing: true` in the session options —
   * without it the CLI answers `canRewind: false`. Pass `dryRun` to preview
   * the change counts without touching the worktree. Starts the process if
   * no turn has run yet (checkpoints ride the resumed session's history).
   */
  async rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<RewindFilesResult> {
    if (this.closed) throw new Error("session is closed");
    this.ensureStarted();
    return this.query!.rewindFiles(userMessageId, options);
  }

  /** End the session and tear down the process. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.end();
    this.query?.close();
  }
}

/**
 * Convenience: start an {@link AgentSession} and immediately send one turn.
 * Returns the session so callers can iterate it, interrupt, or send more.
 */
export function startAgentSession(prompt: string, options: AgentSessionOptions = {}): AgentSession {
  const session = new AgentSession(options);
  session.send(prompt);
  return session;
}
