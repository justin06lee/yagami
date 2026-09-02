/**
 * yagami — your signed-in coding-agent CLIs as an Anthropic/OpenAI-compatible
 * backend.
 *
 * Library mode (embed in your own app — no HTTP server, no URL, no API key):
 *   - `Yagami` — zero-config client mirroring the Anthropic and OpenAI SDK
 *     surfaces (`messages.create`, `chat.completions.create`, `models.list`),
 *     synced with the host machine's yagami config.
 *   - `YagamiEngine` — the engine underneath, for explicit programmatic use.
 *   - `claudeCodeSession` / `AgentSession` — full agentic Claude Code
 *     sessions (tools and all) for building UIs on top of Claude Code.
 *
 * Server mode lives in `yagami/server` (or the `yagami` CLI).
 */

export {
  Yagami,
  type YagamiOptions,
  type YagamiMessages,
  type YagamiChatCompletions,
  type MessageStreamEvent,
} from "./core/client.js";
export {
  chatToMessagesRequest,
  toChatCompletion,
  ChatChunkTranslator,
  modelListBody,
  openAiErrorBody,
  type ChatCompletionsRequest,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatMessageParam,
  type OpenAiUsage,
  type TranslatedChatRequest,
} from "./core/openai.js";
export { loadHostEngineConfig, yagamiConfigDir, type HostEngineConfig } from "./core/hostConfig.js";
export {
  YagamiEngine,
  type EngineOptions,
  type CompleteResult,
  type StreamStart,
  type StreamOptions,
  type StreamResultInfo,
  type EngineModel,
} from "./core/engine.js";
export type {
  EngineReasoningEffort,
  EngineServiceTier,
  EngineInputModality,
} from "./core/models.js";
export { claudeCodeSession, type ClaudeSessionOptions } from "./core/session.js";
export { AgentSession, startAgentSession, type AgentSessionOptions } from "./core/agentSession.js";
export {
  PermissionAdapter,
  type PermissionHandler,
  type PermissionRequest,
  type PermissionDecision,
  type PermissionAdapterOptions,
} from "./core/permission.js";
export { settingSourcesFor, type Parity } from "./core/parity.js";
export type { Provider, ProviderCapabilities, TurnRequest, TurnEvent, ModelRef } from "./core/provider.js";
export { parseModelRef, qualifiedModel, isSessionProvider } from "./core/provider.js";
// the harness-generic agentic session contract (Codex app-server, ACP agents)
export type {
  AgentEvent,
  ProviderSession,
  ProviderSessionOptions,
  ProviderSessionCapabilities,
  SessionProvider,
  SessionPermissionDecision,
  SessionPermissionRequest,
  SessionPermissionHandler,
  SessionInputValue,
  SessionInputOption,
  SessionInputField,
  SessionInputRequest,
  SessionInputResponse,
  SessionInputHandler,
  SessionPlanStatus,
  SessionPlanEntry,
  SessionPlan,
} from "./core/provider.js";
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
  RewindFilesResult,
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
