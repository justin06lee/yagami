import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExecutable } from "./executable.js";

export interface ClaudeSessionOptions {
  /** Path to the `claude` binary. Auto-resolved when omitted. */
  claudePath?: string;
  /** Agent SDK options; merged over yagami's defaults. */
  options?: Options;
}

/**
 * Full agentic Claude Code session (tools, permissions, plan mode — the
 * works), backed by the user's installed, signed-in CLI. This is the
 * embeddable "what T3 Code does" primitive for building UIs like ruri:
 * unlike the Messages-API engine, nothing is restricted here.
 *
 * Defaults to the `claude_code` system prompt preset so behavior matches the
 * interactive CLI; pass `options.systemPrompt` to override.
 */
export function claudeCodeSession(
  prompt: string | AsyncIterable<SDKUserMessage>,
  sessionOptions: ClaudeSessionOptions = {},
): Query {
  const claudePath = resolveClaudeExecutable(
    sessionOptions.claudePath ?? sessionOptions.options?.pathToClaudeCodeExecutable,
  );
  return query({
    prompt,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code" },
      ...sessionOptions.options,
      pathToClaudeCodeExecutable: claudePath,
    },
  });
}

export type {
  Options as AgentOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
  PermissionMode,
  CanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
