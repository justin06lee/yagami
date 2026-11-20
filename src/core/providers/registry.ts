import { findExecutable } from "../executable.js";
import { ProviderNotInstalledError } from "../errors.js";
import type { Provider } from "../provider.js";
import { AcpProvider } from "./acp.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider, type CodexSandboxMode } from "./codex.js";
import { PrintProvider } from "./print.js";

export type ProviderKind = "claude" | "codex" | "acp" | "print";

/** A harness yagami knows how to launch out of the box. */
export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  command: string;
  args: string[];
  /** Environment the launch needs (an experimental-ACP switch, say). */
  env?: Record<string, string>;
  /** Extra environment for completion turns only: what holds the agent to reading. */
  turnEnv?: Record<string, string>;
  /** ACP only: the session mode completion turns run in, where "plan" is the wrong one. */
  turnMode?: string;
  /** Print mode only: arguments that select a model, `{model}` replaced. */
  modelArgs?: string[];
  loginCommand: string;
  installHint: string;
}

/**
 * Built-in catalog. Native drivers for Claude Code and Codex; everything
 * else speaks the Agent Client Protocol, launched the way the ACP registry
 * (cdn.agentclientprotocol.com/registry) launches it, under the command name
 * the vendor's own install puts on PATH. Install and login commands are the
 * vendor's where one is documented; a login given as "run it and sign in"
 * means the CLI has no separate login command.
 *
 * No print-mode CLI is preset. A print mode has no way to be refused a
 * tool, so one belongs here only if it refuses unapproved tools by itself,
 * and Crush and pi (the candidates) run theirs unasked. A host that wants
 * one anyway adds it in config with `kind: "print"`.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: "claude", label: "Claude Code", kind: "claude", command: "claude", args: [], loginCommand: "claude auth login", installHint: "npm i -g @anthropic-ai/claude-code" },
  { id: "codex", label: "Codex CLI", kind: "codex", command: "codex", args: [], loginCommand: "codex login", installHint: "npm i -g @openai/codex" },
  { id: "opencode", label: "OpenCode", kind: "acp", command: "opencode", args: ["acp"], loginCommand: "opencode auth login", installHint: "curl -fsSL https://opencode.ai/install | bash" },
  { id: "gemini", label: "Gemini CLI", kind: "acp", command: "gemini", args: ["--acp"], loginCommand: "gemini (then /auth)", installHint: "npm i -g @google/gemini-cli" },
  { id: "antigravity", label: "Google Antigravity", kind: "acp", command: "agy", args: ["acp"], turnMode: "default", loginCommand: "agy (sign in with Google when it asks)", installHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash (or brew install --cask antigravity-cli)" },
  { id: "copilot", label: "GitHub Copilot CLI", kind: "acp", command: "copilot", args: ["--acp"], loginCommand: "copilot (then /login)", installHint: "npm i -g @github/copilot" },
  { id: "cursor", label: "Cursor Agent", kind: "acp", command: "cursor-agent", args: ["acp"], loginCommand: "cursor-agent login", installHint: "curl https://cursor.com/install -fsS | bash" },
  { id: "grok", label: "Grok Build", kind: "acp", command: "grok", args: ["agent", "stdio"], turnEnv: { GROK_SANDBOX: "read-only" }, loginCommand: "grok login", installHint: "npm i -g @xai-official/grok (or brew install --cask grok-build)" },
  { id: "kimi", label: "Kimi Code", kind: "acp", command: "kimi", args: ["acp"], loginCommand: "kimi login", installHint: "npm i -g @moonshot-ai/kimi-code (or brew install kimi-code)" },
  { id: "muse", label: "Muse Code", kind: "acp", command: "muse", args: ["acp"], env: { MUSE_EXPERIMENTAL_ACP: "on" }, loginCommand: "muse login", installHint: "curl https://dev.meta.ai/install.sh | bash (or brew install --cask muse-code)" },
  { id: "qwen", label: "Qwen Code", kind: "acp", command: "qwen", args: ["--acp"], loginCommand: "qwen (then /auth)", installHint: "npm i -g @qwen-code/qwen-code" },
  { id: "goose", label: "Goose", kind: "acp", command: "goose", args: ["acp"], loginCommand: "goose configure", installHint: "brew install block-goose-cli" },
  { id: "kilo", label: "Kilo", kind: "acp", command: "kilo", args: ["acp"], loginCommand: "kilo login", installHint: "npm i -g @kilocode/cli" },
  { id: "cline", label: "Cline", kind: "acp", command: "cline", args: ["--acp"], loginCommand: "cline auth", installHint: "npm i -g cline" },
  { id: "auggie", label: "Auggie", kind: "acp", command: "auggie", args: ["--acp"], loginCommand: "auggie login", installHint: "npm i -g @augmentcode/auggie" },
  { id: "droid", label: "Factory Droid", kind: "acp", command: "droid", args: ["exec", "--output-format", "acp-daemon"], loginCommand: "droid login", installHint: "curl -fsSL https://app.factory.ai/cli | sh" },
  { id: "kiro", label: "Kiro CLI", kind: "acp", command: "kiro-cli", args: ["acp"], loginCommand: "kiro-cli login", installHint: "curl -fsSL https://cli.kiro.dev/install | bash (or brew install kiro-cli)" },
  { id: "junie", label: "Junie", kind: "acp", command: "junie", args: ["--acp=true"], loginCommand: "junie (sign in with JetBrains when it asks)", installHint: "see junie.jetbrains.com" },
  { id: "devin", label: "Devin", kind: "acp", command: "devin", args: ["acp"], loginCommand: "devin (sign in when it asks)", installHint: "npm i -g devin" },
  { id: "vibe", label: "Mistral Vibe", kind: "acp", command: "vibe-acp", args: [], loginCommand: "vibe (sign in when it asks)", installHint: "curl -LsSf https://mistral.ai/vibe/install.sh | bash" },
  { id: "qoder", label: "Qoder CLI", kind: "acp", command: "qodercli", args: ["--acp"], loginCommand: "qodercli (sign in when it asks)", installHint: "npm i -g @qoder-ai/qodercli" },
  { id: "codebuddy", label: "CodeBuddy Code", kind: "acp", command: "codebuddy", args: ["--acp"], loginCommand: "codebuddy (sign in when it asks)", installHint: "npm i -g @tencent-ai/codebuddy-code" },
  { id: "poolside", label: "Poolside", kind: "acp", command: "pool", args: ["acp"], loginCommand: "pool login", installHint: "curl -fsSL https://downloads.poolside.ai/pool/install.sh | sh" },
  { id: "stakpak", label: "Stakpak", kind: "acp", command: "stakpak", args: ["acp"], loginCommand: "stakpak auth login", installHint: "brew install stakpak" },
  { id: "cortex", label: "Cortex Code", kind: "acp", command: "cortex", args: ["acp", "serve"], loginCommand: "cortex (sign in to Snowflake when it asks)", installHint: "see docs.snowflake.com/en/user-guide/cortex-code/cortex-code" },
  { id: "autohand", label: "Autohand Code", kind: "acp", command: "autohand", args: ["--acp"], loginCommand: "autohand --login", installHint: "npm i -g autohand-cli" },
  { id: "kimchi", label: "Kimchi", kind: "acp", command: "kimchi", args: ["--mode", "acp"], loginCommand: "kimchi login", installHint: "brew install getkimchi/tap/kimchi" },
  { id: "minimax", label: "MiniMax Code", kind: "acp", command: "code-acp", args: ["acp"], loginCommand: "code-acp (sign in per agent.minimax.io)", installHint: "npm i -g @minimax-ai/code-acp" },
  { id: "bob", label: "IBM Bob", kind: "acp", command: "bob", args: ["acp"], loginCommand: "bob (sign in when it asks)", installHint: "npm i -g @ibm/bob" },
  { id: "nova", label: "Nova (Compass AI)", kind: "acp", command: "nova", args: ["acp"], loginCommand: "nova (sign in when it asks)", installHint: "npm i -g @compass-ai/nova" },
  { id: "vtcode", label: "VT Code", kind: "acp", command: "vtcode", args: ["acp"], env: { VT_ACP_ENABLED: "1", VT_ACP_ZED_ENABLED: "1" }, loginCommand: "vtcode login", installHint: "brew install vinhnx/tap/vtcode" },
  { id: "dirac", label: "Dirac", kind: "acp", command: "dirac", args: ["--acp"], loginCommand: "dirac (sign in when it asks)", installHint: "npm i -g dirac-cli" },
  { id: "dimcode", label: "DimCode", kind: "acp", command: "dim", args: ["acp"], loginCommand: "dim (sign in when it asks)", installHint: "npm i -g dimcode" },
  { id: "deepagents", label: "DeepAgents", kind: "acp", command: "deepagents-acp", args: [], loginCommand: "deepagents-acp (set a model provider key per its docs)", installHint: "npm i -g deepagents-acp" },
  { id: "fast-agent", label: "fast-agent", kind: "acp", command: "fast-agent-acp", args: ["-x"], loginCommand: "fast-agent-acp (set a model provider key per fast-agent.ai)", installHint: "uv tool install fast-agent-acp" },
  { id: "glm", label: "GLM Agent", kind: "acp", command: "glm-acp-agent", args: [], loginCommand: "glm-acp-agent (set your GLM Coding Plan key per its docs)", installHint: "npm i -g glm-acp-agent" },
  { id: "corust", label: "Corust Agent", kind: "acp", command: "corust-agent-acp", args: [], loginCommand: "corust-agent-acp (sign in per corust.ai)", installHint: "see corust.ai" },
  { id: "crow", label: "crow-cli", kind: "acp", command: "crow-cli", args: ["acp"], loginCommand: "crow-cli (set a model provider key per crow-ai.dev)", installHint: "uv tool install crow-cli --python 3.13" },
  { id: "harn", label: "Harn", kind: "acp", command: "harn", args: ["serve", "acp"], loginCommand: "harn (set a model provider key per harnlang.com)", installHint: "curl -fsSL https://harnlang.com/install.sh | sh" },
  { id: "sigit", label: "siGit Code", kind: "acp", command: "sigit", args: [], loginCommand: "sigit (runs local models; nothing to sign in to)", installHint: "npm i -g @getsigit/sigit" },
  { id: "minion", label: "Minion Code", kind: "acp", command: "minion-code", args: ["acp"], loginCommand: "minion-code (set a model provider key per its docs)", installHint: "uv tool install minion-code" },
  { id: "amp", label: "Amp", kind: "acp", command: "amp-acp", args: [], loginCommand: "amp login", installHint: "see github.com/tao12345666333/amp-acp (an ACP adapter for the amp CLI)" },
  { id: "codex-acp", label: "Codex (ACP adapter)", kind: "acp", command: "codex-acp", args: [], loginCommand: "codex login", installHint: "npm i -g @agentclientprotocol/codex-acp" },
  { id: "claude-acp", label: "Claude (ACP adapter)", kind: "acp", command: "claude-agent-acp", args: [], loginCommand: "claude auth login", installHint: "npm i -g @agentclientprotocol/claude-agent-acp" },
];

/** Per-provider settings from config.json (`providers.<id>`). */
export interface ProviderConfigEntry {
  /**
   * What kind of harness this entry is, for ids that are not presets. A
   * second Claude Code account is `{ kind: "claude", configDir }` under its
   * own id; a CLI with only a print mode is `{ kind: "print", command, args }`.
   * Default: the preset's kind, else "acp".
   */
  kind?: ProviderKind;
  /** Explicit executable path. */
  path?: string;
  /** Launch command for custom agents (and overrides for presets). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  label?: string;
  /** Claude only: the account's config directory (CLAUDE_CONFIG_DIR). `~/.claude` is the default account. */
  configDir?: string;
  /** Codex only: sandbox for completion turns. */
  sandbox?: CodexSandboxMode;
  /** ACP only: id of the model config option (default "model"). */
  modelConfigId?: string;
  /** ACP only: the session mode completion turns run in (default: a plan/read-only mode when offered). */
  turnMode?: string;
  /** Print mode only: arguments that select a model, `{model}` replaced. */
  modelArgs?: string[];
  /** Print mode only: model ids to list. */
  models?: string[];
  loginCommand?: string;
  installHint?: string;
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

/**
 * The preset an entry builds on: its own, or — for a custom id that names a
 * native kind (a second Claude account) — that harness's.
 */
function basePreset(id: string, entry: ProviderConfigEntry): ProviderPreset | undefined {
  const own = presetFor(id);
  if (own && (!entry.kind || entry.kind === own.kind)) return own;
  return entry.kind === "claude" || entry.kind === "codex" ? presetFor(entry.kind) : undefined;
}

/** Instantiate one provider by id from a preset and/or config entry. */
export function createProvider(id: string, entry: ProviderConfigEntry = {}, common: ProviderCommonOptions = {}): Provider {
  const preset = basePreset(id, entry);
  const kind: ProviderKind = entry.kind ?? preset?.kind ?? "acp";
  if (kind === "claude") {
    return new ClaudeProvider({
      ...(id !== "claude" ? { id, label: entry.label ?? `Claude Code (${id})` } : entry.label ? { label: entry.label } : {}),
      ...(entry.path ? { path: entry.path } : {}),
      ...(entry.configDir ? { configDir: entry.configDir } : {}),
      ...common,
    });
  }
  if (kind === "codex") {
    if (id !== "codex") {
      throw new ProviderNotInstalledError(id, "Codex runs as the one `codex` provider; point it elsewhere with providers.codex.env.CODEX_HOME.", "a second codex provider is not supported");
    }
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
  const env = { ...preset?.env, ...entry.env };
  const shared = {
    id,
    label: entry.label ?? preset?.label ?? id,
    command,
    args: entry.args ?? preset?.args ?? [],
    ...(entry.path ? { path: entry.path } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    loginCommand: entry.loginCommand ?? preset?.loginCommand ?? `${command} (sign in per its docs)`,
    installHint: entry.installHint ?? preset?.installHint ?? `Install \`${command}\`.`,
    ...(common.workDir ? { workDir: common.workDir } : {}),
  };
  if (kind === "print") {
    const modelArgs = entry.modelArgs ?? preset?.modelArgs;
    return new PrintProvider({
      ...shared,
      ...(modelArgs ? { modelArgs } : {}),
      ...(entry.models ? { models: entry.models } : {}),
    });
  }
  return new AcpProvider({
    ...shared,
    ...(preset?.turnEnv ? { turnEnv: preset.turnEnv } : {}),
    ...(entry.turnMode ?? preset?.turnMode ? { turnMode: entry.turnMode ?? preset?.turnMode } : {}),
    ...(entry.modelConfigId ? { modelConfigId: entry.modelConfigId } : {}),
    ...(common.appName ? { appName: common.appName } : {}),
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
    const entry = config[id] ?? {};
    const preset = basePreset(id, entry);
    const kind: ProviderKind = entry.kind ?? preset?.kind ?? "acp";
    const command = entry.command ?? preset?.command ?? id;
    const path = findExecutable(command, entry.path ? { explicit: entry.path } : {});
    return {
      id,
      label: entry.label ?? (kind === "claude" && id !== "claude" ? `Claude Code (${id})` : preset?.label ?? id),
      kind,
      installed: path !== undefined && entry.enabled !== false,
      ...(path ? { path } : {}),
      loginCommand: entry.loginCommand ?? preset?.loginCommand ?? `${command} (sign in per its docs)`,
      installHint: entry.installHint ?? preset?.installHint ?? `Install \`${command}\`.`,
    };
  });
}
