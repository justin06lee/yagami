import { findExecutable } from "../executable.js";
import { ProviderNotInstalledError } from "../errors.js";
import type { Provider } from "../provider.js";
import { AcpProvider } from "./acp.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider, type CodexSandboxMode } from "./codex.js";

export type ProviderKind = "claude" | "codex" | "acp";

/** A harness yagami knows how to launch out of the box. */
export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  command: string;
  args: string[];
  loginCommand: string;
  installHint: string;
}

/**
 * Built-in catalog. Native drivers for Claude Code and Codex; everything
 * else speaks the Agent Client Protocol, with launch commands taken from
 * the ACP registry (cdn.agentclientprotocol.com/registry). Login commands
 * are best-effort hints.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "claude", label: "Claude Code", kind: "claude", command: "claude", args: [], loginCommand: "claude (then /login)", installHint: "npm i -g @anthropic-ai/claude-code" },
  { id: "codex", label: "Codex CLI", kind: "codex", command: "codex", args: [], loginCommand: "codex login", installHint: "npm i -g @openai/codex" },
  { id: "opencode", label: "OpenCode", kind: "acp", command: "opencode", args: ["acp"], loginCommand: "opencode auth login", installHint: "curl -fsSL https://opencode.ai/install | bash" },
  { id: "gemini", label: "Gemini CLI", kind: "acp", command: "gemini", args: ["--acp"], loginCommand: "gemini (then /auth)", installHint: "npm i -g @google/gemini-cli" },
  { id: "copilot", label: "GitHub Copilot CLI", kind: "acp", command: "copilot", args: ["--acp"], loginCommand: "copilot (then /login)", installHint: "npm i -g @github/copilot" },
  { id: "qwen", label: "Qwen Code", kind: "acp", command: "qwen", args: ["--acp"], loginCommand: "qwen (then /auth)", installHint: "npm i -g @qwen-code/qwen-code" },
  { id: "cursor", label: "Cursor Agent", kind: "acp", command: "cursor-agent", args: ["acp"], loginCommand: "cursor-agent login", installHint: "curl https://cursor.com/install -fsS | bash" },
  { id: "goose", label: "Goose", kind: "acp", command: "goose", args: ["acp"], loginCommand: "goose configure", installHint: "brew install block-goose-cli" },
  { id: "kimi", label: "Kimi CLI", kind: "acp", command: "kimi", args: ["acp"], loginCommand: "kimi login", installHint: "see github.com/MoonshotAI/kimi-cli" },
  { id: "kilo", label: "Kilo", kind: "acp", command: "kilo", args: ["acp"], loginCommand: "kilo login", installHint: "npm i -g @kilocode/cli" },
  { id: "cline", label: "Cline", kind: "acp", command: "cline", args: ["--acp"], loginCommand: "cline auth", installHint: "npm i -g cline" },
  { id: "auggie", label: "Auggie", kind: "acp", command: "auggie", args: ["--acp"], loginCommand: "auggie login", installHint: "npm i -g @augmentcode/auggie" },
  { id: "amp", label: "Amp", kind: "acp", command: "amp-acp", args: [], loginCommand: "amp login", installHint: "see ampcode.com" },
  { id: "grok", label: "Grok Build", kind: "acp", command: "grok", args: ["agent", "stdio"], loginCommand: "grok login", installHint: "npm i -g @xai-official/grok" },
  { id: "droid", label: "Factory Droid", kind: "acp", command: "droid", args: ["exec", "--output-format", "acp-daemon"], loginCommand: "droid login", installHint: "curl -fsSL https://app.factory.ai/cli | sh" },
  { id: "codex-acp", label: "Codex (ACP adapter)", kind: "acp", command: "codex-acp", args: [], loginCommand: "codex login", installHint: "npm i -g @agentclientprotocol/codex-acp" },
  { id: "claude-acp", label: "Claude (ACP adapter)", kind: "acp", command: "claude-agent-acp", args: [], loginCommand: "claude (then /login)", installHint: "npm i -g @agentclientprotocol/claude-agent-acp" },
];

/** Per-provider settings from config.json (`providers.<id>`). */
export interface ProviderConfigEntry {
  /** Explicit executable path. */
  path?: string;
  /** Launch command for custom ACP agents (and overrides for presets). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  label?: string;
  /** Claude only: CLAUDE_CONFIG_DIR isolation. */
  configDir?: string;
  /** Codex only: sandbox for completion turns. */
  sandbox?: CodexSandboxMode;
  /** ACP only: id of the model config option (default "model"). */
  modelConfigId?: string;
  loginCommand?: string;
  /** Set false to skip this preset even if installed. */
  enabled?: boolean;
}

export interface ProviderCommonOptions {
  workDir?: string;
  appName?: string;
}

export function presetFor(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/** Instantiate one provider by id from a preset and/or config entry. */
export function createProvider(id: string, entry: ProviderConfigEntry = {}, common: ProviderCommonOptions = {}): Provider {
  const preset = presetFor(id);
  const kind: ProviderKind = preset?.kind ?? "acp";
  if (kind === "claude") {
    return new ClaudeProvider({
      ...(entry.path ? { path: entry.path } : {}),
      ...(entry.configDir ? { configDir: entry.configDir } : {}),
      ...common,
    });
  }
  if (kind === "codex") {
    return new CodexProvider({
      ...(entry.path ? { path: entry.path } : {}),
      ...(entry.sandbox ? { sandbox: entry.sandbox } : {}),
      ...(entry.env ? { env: entry.env } : {}),
      ...(common.workDir ? { workDir: common.workDir } : {}),
    });
  }
  const command = entry.command ?? preset?.command;
  if (!command) {
    throw new ProviderNotInstalledError(id, `Add providers.${id}.command (an ACP agent launch command) to config.json.`, "unknown provider with no command");
  }
  return new AcpProvider({
    id,
    label: entry.label ?? preset?.label ?? id,
    command,
    args: entry.args ?? preset?.args ?? [],
    ...(entry.path ? { path: entry.path } : {}),
    ...(entry.env ? { env: entry.env } : {}),
    ...(entry.modelConfigId ? { modelConfigId: entry.modelConfigId } : {}),
    loginCommand: entry.loginCommand ?? preset?.loginCommand ?? `${command} (sign in per its docs)`,
    installHint: preset?.installHint ?? `Install \`${command}\`.`,
    ...common,
  });
}

export interface LoadedProviders {
  providers: Map<string, Provider>;
  /** Providers that couldn't be constructed, with the reason (usually not installed). */
  unavailable: Map<string, string>;
}

/**
 * Build every provider that is installed on this machine: all presets plus
 * any custom entries in config. Missing CLIs are recorded, not fatal.
 */
export function loadProviders(
  config: Record<string, ProviderConfigEntry> = {},
  common: ProviderCommonOptions = {},
): LoadedProviders {
  const ids = new Set<string>([...PROVIDER_PRESETS.map((p) => p.id), ...Object.keys(config)]);
  const providers = new Map<string, Provider>();
  const unavailable = new Map<string, string>();
  for (const id of ids) {
    const entry = config[id] ?? {};
    if (entry.enabled === false) {
      unavailable.set(id, "disabled in config");
      continue;
    }
    try {
      providers.set(id, createProvider(id, entry, common));
    } catch (err) {
      unavailable.set(id, err instanceof Error ? err.message : String(err));
    }
  }
  return { providers, unavailable };
}

export interface DetectedProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  installed: boolean;
  path?: string;
  loginCommand: string;
  installHint: string;
}

/** Which known harnesses exist on this machine (cheap: no processes spawned). */
export function detectProviders(config: Record<string, ProviderConfigEntry> = {}): DetectedProvider[] {
  const ids = new Set<string>([...PROVIDER_PRESETS.map((p) => p.id), ...Object.keys(config)]);
  return [...ids].map((id) => {
    const preset = presetFor(id);
    const entry = config[id] ?? {};
    const command = entry.command ?? preset?.command ?? id;
    const path = findExecutable(command, entry.path ? { explicit: entry.path } : {});
    return {
      id,
      label: entry.label ?? preset?.label ?? id,
      kind: preset?.kind ?? "acp",
      installed: path !== undefined && entry.enabled !== false,
      ...(path ? { path } : {}),
      loginCommand: entry.loginCommand ?? preset?.loginCommand ?? `${command} (sign in per its docs)`,
      installHint: preset?.installHint ?? `Install \`${command}\`.`,
    };
  });
}
