/**
 * yagami — your signed-in Claude Code CLI as an Anthropic-compatible backend.
 *
 * Library mode (embed in your own app, no HTTP server):
 *   - `YagamiEngine` — Anthropic Messages API in/out, Claude Code underneath.
 *   - `claudeCodeSession` — full agentic Claude Code sessions (tools and all)
 *     for building UIs on top of Claude Code.
 *
 * Server mode lives in `yagami/server` (or the `yagami` CLI).
 */

export {
  YagamiEngine,
  type EngineOptions,
  type CompleteResult,
  type StreamStart,
  type StreamOptions,
  type StreamResultInfo,
  type EngineModel,
} from "./core/engine.js";
export { claudeCodeSession, type ClaudeSessionOptions } from "./core/session.js";
export type { Provider, ProviderCapabilities, TurnRequest, TurnEvent, ModelRef } from "./core/provider.js";
export { parseModelRef, qualifiedModel } from "./core/provider.js";
export { ClaudeProvider, type ClaudeProviderOptions } from "./core/providers/claude.js";
export { CodexProvider, type CodexProviderOptions, type CodexSandboxMode } from "./core/providers/codex.js";
export { AcpProvider, type AcpProviderOptions, type AcpConnection } from "./core/providers/acp.js";
export {
  PROVIDER_PRESETS,
  createProvider,
  loadProviders,
  detectProviders,
  presetFor,
  type ProviderPreset,
  type ProviderKind,
  type ProviderConfigEntry,
  type LoadedProviders,
  type DetectedProvider,
} from "./core/providers/registry.js";
export {
  YagamiError,
  ProviderNotInstalledError,
  AuthRequiredError,
  ProviderError,
  toApiError,
  type VersionSkew,
} from "./core/errors.js";
export type {
  AgentOptions,
  Query,
  SDKMessage,
  SDKUserMessage,
  PermissionMode,
  CanUseTool,
} from "./core/session.js";
export { resolveClaudeExecutable, resolveExecutable, findExecutable } from "./core/executable.js";
export { SessionCache, type SessionCacheOptions } from "./core/sessionCache.js";
export {
  ApiError,
  type ApiErrorType,
  type MessagesRequest,
  type MessagesResponse,
  type MessageParam,
  type SystemParam,
  type ContentBlock,
  type ContentBlockParam,
  type Usage,
  type SseEvent,
} from "./core/types.js";
export { VERSION } from "./version.js";
