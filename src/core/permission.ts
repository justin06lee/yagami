import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";

/** A tool-use request handed to the host for a decision. */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  /**
   * Suggested permission updates the host can echo back to stop being asked
   * again this session (e.g. behind an "always allow" button).
   */
  suggestions?: PermissionUpdate[];
}

/**
 * The host's answer. `allow` optionally rewrites the tool input and/or
 * persists permission updates for the rest of the session; `deny` carries a
 * message the model sees and can optionally interrupt the turn.
 */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: "deny"; message?: string; interrupt?: boolean };

/** What the app implements: show UI, return a decision. */
export type PermissionHandler = (req: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;

export interface PermissionAdapterOptions {
  /**
   * Decision used when no handler is set, a handler throws, or the request is
   * aborted. Defaults to denying — the safe choice for an unattended host.
   */
  fallback?: "allow" | "deny";
  /** Tool names to auto-allow without ever calling the handler. */
  autoAllow?: Iterable<string>;
  /** Tool names to auto-deny without ever calling the handler. */
  autoDeny?: Iterable<string>;
}

/**
 * Turns a host-supplied {@link PermissionHandler} into the Agent SDK's
 * {@link CanUseTool} callback, owning the state machine so the app only has
 * to answer one question: allow or deny this tool call?
 *
 * The policy (what to auto-approve) stays with the app — yagami never bakes
 * in a permissive default. Without a handler, everything falls back (deny by
 * default), so a session is safe before the UI is wired up.
 */
export class PermissionAdapter {
  private handler: PermissionHandler | undefined;
  private readonly fallback: "allow" | "deny";
  private readonly autoAllow: Set<string>;
  private readonly autoDeny: Set<string>;

  constructor(options: PermissionAdapterOptions = {}) {
    this.fallback = options.fallback ?? "deny";
    this.autoAllow = new Set(options.autoAllow ?? []);
    this.autoDeny = new Set(options.autoDeny ?? []);
  }

  /** Install (or replace) the host decision callback. */
  setHandler(handler: PermissionHandler | undefined): void {
    this.handler = handler;
  }

  allowTool(toolName: string): void {
    this.autoDeny.delete(toolName);
    this.autoAllow.add(toolName);
  }

  denyTool(toolName: string): void {
    this.autoAllow.delete(toolName);
    this.autoDeny.add(toolName);
  }

  private fallbackResult(reason: string): PermissionResult {
    return this.fallback === "allow"
      ? { behavior: "allow", updatedInput: {} }
      : { behavior: "deny", message: reason };
  }

  /**
   * The callback to hand to `claudeCodeSession`/the Agent SDK. Typed to
   * always resolve (never null), and assignable to the SDK's CanUseTool.
   */
  readonly canUseTool: (
    ...args: Parameters<CanUseTool>
  ) => Promise<PermissionResult> = async (toolName, input, options) => {
    if (this.autoDeny.has(toolName)) {
      return { behavior: "deny", message: `tool "${toolName}" is disabled for this session` };
    }
    if (this.autoAllow.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }
    if (!this.handler) return this.fallbackResult(`no permission handler is set; denying "${toolName}"`);
    if (options.signal.aborted) return this.fallbackResult("request aborted");

    let decision: PermissionDecision;
    try {
      decision = await this.handler({
        toolName,
        input,
        signal: options.signal,
        ...(options.suggestions ? { suggestions: options.suggestions } : {}),
      });
    } catch (err) {
      return this.fallbackResult(`permission handler threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (decision.behavior === "allow") {
      return {
        behavior: "allow",
        updatedInput: decision.updatedInput ?? input,
        ...(decision.updatedPermissions ? { updatedPermissions: decision.updatedPermissions } : {}),
      };
    }
    return {
      behavior: "deny",
      message: decision.message ?? `tool "${toolName}" denied by host`,
      ...(decision.interrupt ? { interrupt: true } : {}),
    };
  };
}
