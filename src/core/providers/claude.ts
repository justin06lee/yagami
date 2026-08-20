import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  query,
  type CanUseTool,
  type Options,
  type SDKResultMessage,
  type SDKUserMessage,
  type ThinkingConfig,
  type EffortLevel,
} from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExecutable } from "../executable.js";
import { classifyProviderFailure, ProviderError, type VersionSkew } from "../errors.js";
import type { EngineModel } from "../models.js";
import type { Provider, ProviderCapabilities, TurnEvent, TurnRequest } from "../provider.js";
import type { ContentBlockParam, ThinkingParam, Usage } from "../types.js";
import { VERSION } from "../../version.js";

// The API surface is pure completions: even though `tools: []` removes every
// built-in tool, deny anything that somehow still asks.
const DENY_ALL_TOOLS: CanUseTool = async (toolName) => ({
  behavior: "deny",
  message: `yagami is a completions-only endpoint; tool "${toolName}" is disabled.`,
  interrupt: true,
});

export interface ClaudeProviderOptions {
  /** Path to the `claude` binary. Auto-resolved when omitted. */
  path?: string;
  /** Optional CLAUDE_CONFIG_DIR override for the spawned CLI. */
  configDir?: string;
  /** Working directory for completion turns (inert — tools are disabled). */
  workDir?: string;
  /** Reported to the CLI as the client application. */
  appName?: string;
}

interface RawStreamEvent {
  type: string;
  [key: string]: unknown;
}

/** Claude Code through the Agent SDK, pointed at the user's signed-in binary. */
export class ClaudeProvider implements Provider {
  readonly id = "claude";
  readonly label = "Claude Code";
  readonly executable: string;
  readonly loginCommand = "claude (then /login)";
  readonly capabilities: ProviderCapabilities = {
    resume: true,
    fork: true,
    images: true,
    documents: true,
    systemPrompt: true,
    thinking: true,
    effort: true,
    streaming: "tokens",
  };

  private readonly configDir: string | undefined;
  private readonly workDir: string;
  private readonly appName: string;

  constructor(options: ClaudeProviderOptions = {}) {
    this.executable = resolveClaudeExecutable(options.path);
    this.configDir = options.configDir;
    this.appName = options.appName ?? "yagami";
    this.workDir = options.workDir ?? path.join(os.tmpdir(), "yagami-workspace");
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  /** Hardened options shared by every completion turn and probe. */
  private baseOptions(): Options {
    return {
      pathToClaudeCodeExecutable: this.executable,
      cwd: this.workDir,
      // Pure completions: no built-in tools, no settings/CLAUDE.md/skills
      // leaking in, exactly one assistant turn per request.
      tools: [],
      settingSources: [],
      maxTurns: 1,
      canUseTool: DENY_ALL_TOOLS,
      env: {
        ...process.env,
        ...(this.configDir ? { CLAUDE_CONFIG_DIR: this.configDir } : {}),
        CLAUDE_AGENT_SDK_CLIENT_APP: `${this.appName}/${VERSION}`,
      },
    };
  }

  async *run(req: TurnRequest): AsyncGenerator<TurnEvent, void, undefined> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const options: Options = { ...this.baseOptions(), abortController, includePartialMessages: true };
    if (req.model) options.model = req.model;
    if (req.system !== undefined) options.systemPrompt = req.system;
    if (req.resume) {
      options.resume = req.resume;
      // Fork so several conversation branches can share one cached prefix
      // without corrupting each other's transcripts.
      options.forkSession = true;
    }
    const thinking = mapThinking(req.thinking);
    if (thinking) options.thinking = thinking;
    if (req.effort) options.effort = req.effort as EffortLevel;

    const prompt = req.media && req.media.length > 0 ? mediaPrompt(req.prompt, req.media) : req.prompt;

    let result: SDKResultMessage | undefined;
    let model: string | undefined;
    let stopReason: string | undefined;
    let sawText = false;

    try {
      for await (const msg of query({ prompt, options })) {
        if (msg.type === "system" && msg.subtype === "init") {
          yield { type: "session", sessionId: msg.session_id };
        } else if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
          const event = msg.event as unknown as RawStreamEvent;
          if (event.type !== "content_block_delta") continue;
          const delta = event["delta"] as { type?: string; text?: string; thinking?: string } | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            sawText = true;
            yield { type: "text", text: delta.text };
          } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            yield { type: "thinking", text: delta.thinking };
          }
        } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
          const raw = msg.message as { model?: string; stop_reason?: string | null };
          if (typeof raw.model === "string") model = raw.model;
          if (typeof raw.stop_reason === "string") stopReason = raw.stop_reason;
        } else if (msg.type === "result") {
          result = msg;
        }
      }
    } catch (err) {
      throw classifyProviderFailure(this.id, this.loginCommand, err);
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }

    if (req.signal?.aborted) return;
    if (!result) throw new ProviderError(this.id, "engine terminated without producing a result");
    if (result.subtype !== "success") {
      const detail = "errors" in result && result.errors.length > 0 ? result.errors.join("; ") : result.subtype;
      throw classifyProviderFailure(this.id, this.loginCommand, new Error(`engine error: ${detail}`));
    }
    // Some engine paths emit no partial events; fall back to the final text.
    if (!sawText && result.result) yield { type: "text", text: result.result };

    yield {
      type: "done",
      usage: mapUsage(result.usage as unknown as Record<string, unknown>),
      ...(result.total_cost_usd !== undefined ? { costUsd: result.total_cost_usd } : {}),
      ...(model ? { model } : {}),
      ...(stopReason ? { stopReason } : {}),
    };
  }

  /** Ask the CLI which models it supports via a short-lived control session. */
  async listModels(): Promise<EngineModel[]> {
    const abortController = new AbortController();
    // A streaming-input prompt that stays open: the spawned CLI idles while
    // the supported-models control request runs, then gets torn down.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const idle = (async function* (): AsyncGenerator<SDKUserMessage> {
      await gate;
    })();

    const q = query({ prompt: idle, options: { ...this.baseOptions(), abortController } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const models = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out probing supported models")), 15_000);
          timer.unref?.();
        }),
      ]);
      return models.map((m) => ({
        id: m.value,
        display_name: m.displayName,
        ...(m.description ? { description: m.description } : {}),
        ...(m.resolvedModel ? { resolved_model: m.resolvedModel } : {}),
      }));
    } catch (err) {
      throw classifyProviderFailure(this.id, this.loginCommand, err);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      abortController.abort();
    }
  }

  async version(): Promise<string | undefined> {
    try {
      const out = spawnSync(this.executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
      return out.stdout?.trim().split("\n")[0] || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Compare the bundled Agent SDK build against the installed CLI. Their
   * last version components track the same build number when in sync.
   */
  async versionSkew(): Promise<VersionSkew | undefined> {
    const binary = await this.version();
    const sdk = sdkVersion();
    if (!binary || !sdk) return undefined;
    const binaryVersion = binary.match(/\d+\.\d+\.\d+/)?.[0];
    if (!binaryVersion) return undefined;
    const sdkBuild = sdk.split(".").pop();
    const binBuild = binaryVersion.split(".").pop();
    const inSync = sdkBuild === binBuild;
    return {
      sdkVersion: sdk,
      binaryVersion,
      inSync,
      note: inSync
        ? "Agent SDK and claude binary are the same build"
        : `Agent SDK ${sdk} was built alongside claude x.y.${sdkBuild}; you run ${binaryVersion}. Usually fine — update whichever is older if something misbehaves.`,
    };
  }
}

function sdkVersion(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve("@anthropic-ai/claude-agent-sdk");
    let dir = path.dirname(entry);
    for (let i = 0; i < 4; i += 1) {
      const pkg = path.join(dir, "package.json");
      if (fs.existsSync(pkg)) {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string; version?: string };
        if (parsed.name === "@anthropic-ai/claude-agent-sdk") return parsed.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // not resolvable (bundled differently) — skip the check
  }
  return undefined;
}

function mapThinking(t: ThinkingParam | undefined): ThinkingConfig | undefined {
  if (t == null) return undefined;
  if (t.type === "enabled") {
    return typeof t.budget_tokens === "number" ? { type: "enabled", budgetTokens: t.budget_tokens } : { type: "enabled" };
  }
  if (t.type === "disabled") return { type: "disabled" };
  return { type: "adaptive" };
}

export function mapUsage(usage: Record<string, unknown>): Usage {
  const num = (key: string): number | undefined => (typeof usage[key] === "number" ? (usage[key] as number) : undefined);
  return {
    input_tokens: num("input_tokens") ?? 0,
    output_tokens: num("output_tokens") ?? 0,
    cache_creation_input_tokens: num("cache_creation_input_tokens") ?? 0,
    cache_read_input_tokens: num("cache_read_input_tokens") ?? 0,
  };
}

/**
 * User turn carrying image/document blocks: sent via the SDK's streaming
 * input mode, which accepts full Anthropic content blocks. The iterable
 * yields exactly one message, so the turn (and process) still ends normally.
 */
function mediaPrompt(text: string, media: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
  const content = [...media, ...(text.length > 0 ? [{ type: "text", text }] : [])];
  const message = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage;
  return (async function* () {
    yield message;
  })();
}
