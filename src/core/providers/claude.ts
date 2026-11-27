import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  query,
  type CanUseTool,
  type Options,
  type McpServerConfig,
  type SDKResultMessage,
  type SDKUserMessage,
  type ThinkingConfig,
  type EffortLevel,
} from "@anthropic-ai/claude-agent-sdk";
import { expandHome, resolveClaudeExecutable } from "../executable.js";
import { classifyProviderFailure, looksLikeUsageLimit, ProviderError, UsageLimitError, type VersionSkew } from "../errors.js";
import { debug } from "../log.js";
import { flattenToolResultContent, mcpToolAllowed, parseMcpToolName, type McpServerSpec } from "../mcp.js";
import { claudeLongContextModel, claudeResultContextWindow } from "../claudeModels.js";
import type { EngineModel } from "../models.js";
import type { PlanLimit, PlanUsage, Provider, ProviderCapabilities, ProviderStatus, TurnEvent, TurnRequest } from "../provider.js";
import type { ContentBlockParam, ThinkingParam, Usage } from "../types.js";
import { runCommand } from "./process.js";
import { VERSION } from "../../version.js";

// The API surface is pure completions: even though `tools: []` removes every
// built-in tool, deny anything that somehow still asks.
const DENY_ALL_TOOLS: CanUseTool = async (toolName) => ({
  behavior: "deny",
  message: `yagami is a completions-only endpoint; tool "${toolName}" is disabled.`,
  interrupt: true,
});

/**
 * Allow exactly the server tools this turn enabled, deny everything else.
 * Belt and braces: `options.tools` already restricts what exists, but a
 * completions endpoint should not depend on one gate.
 */
const allowOnly = (enabled: string[]): CanUseTool => {
  const allowed = new Set(enabled);
  return async (toolName, input) =>
    allowed.has(toolName)
      ? { behavior: "allow", updatedInput: input }
      : {
          behavior: "deny",
          message: `yagami is a completions-only endpoint; tool "${toolName}" is disabled.`,
          interrupt: true,
        };
};

/**
 * Turn cap once server tools are in play. A search-and-answer turn needs
 * several round trips, but an unbounded loop on a completions endpoint is a
 * cost bug, so it stays bounded.
 */
const SERVER_TOOL_MAX_TURNS = 24;

/**
 * Turn cap with MCP servers connected: the model is doing real work against
 * the caller's own tools (an editor, an app), so it gets room, but a runaway
 * loop still ends.
 */
const MCP_MAX_TURNS = 64;

/**
 * Allow the enabled server tools and the tools of the request's MCP servers
 * (`mcp__<server>__<tool>`), subject to each server's allow list. Denials
 * are reported back to the model without ending the turn, so it can adapt.
 */
const allowMcp = (servers: Record<string, McpServerSpec>, serverTools: string[]): CanUseTool => {
  const enabled = new Set(serverTools);
  return async (toolName, input) => {
    if (enabled.has(toolName)) return { behavior: "allow", updatedInput: input };
    const parsed = parseMcpToolName(toolName);
    const spec = parsed ? servers[parsed.server] : undefined;
    if (parsed && spec && mcpToolAllowed(spec, parsed.tool)) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: `tool "${toolName}" is not enabled for this request.` };
  };
};

export interface ClaudeProviderOptions {
  /** Provider id (default "claude"). A second account is a second provider under its own id. */
  id?: string;
  label?: string;
  /** Path to the `claude` binary. Auto-resolved when omitted. */
  path?: string;
  /**
   * The Claude Code account to use, by its config directory
   * (CLAUDE_CONFIG_DIR). Omitted, the CLI runs as the host process would run
   * it; `~/.claude` selects the default account even when the host's own
   * environment points somewhere else.
   */
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
  readonly id: string;
  readonly label: string;
  readonly executable: string;
  readonly loginCommand: string;
  readonly capabilities: ProviderCapabilities = {
    resume: true,
    fork: true,
    images: true,
    documents: true,
    systemPrompt: true,
    thinking: true,
    effort: true,
    streaming: "tokens",
    serverTools: true,
    mcpServers: true,
  };

  private readonly observedContexts = new Map<string, number>();
  private readonly configDir: string | undefined;
  private readonly workDir: string;
  private readonly appName: string;

  constructor(options: ClaudeProviderOptions = {}) {
    this.id = options.id ?? "claude";
    this.label = options.label ?? "Claude Code";
    this.executable = resolveClaudeExecutable(options.path);
    this.configDir = options.configDir ? path.resolve(expandHome(options.configDir)) : undefined;
    const elsewhere = this.configDir && this.configDir !== path.join(os.homedir(), ".claude");
    this.loginCommand = `${elsewhere ? `CLAUDE_CONFIG_DIR=${this.configDir} ` : ""}claude auth login`;
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
      // leaking in, exactly one assistant turn per request. Only a request's
      // own MCP servers load: the account's claude.ai connectors otherwise
      // join whenever they connect before the turn, ~10k input tokens each time.
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      maxTurns: 1,
      canUseTool: DENY_ALL_TOOLS,
      env: { ...this.accountEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: `${this.appName}/${VERSION}` },
    };
  }

  /**
   * The environment that selects this provider's account. The default
   * account is the *absence* of CLAUDE_CONFIG_DIR: the CLI keys its stored
   * login on the variable, so naming `~/.claude` outright reads as a
   * different, signed-out account.
   */
  private accountEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!this.configDir) return env;
    if (this.configDir === path.join(os.homedir(), ".claude")) delete env["CLAUDE_CONFIG_DIR"];
    else env["CLAUDE_CONFIG_DIR"] = this.configDir;
    return env;
  }

  async *run(req: TurnRequest): AsyncGenerator<TurnEvent, void, undefined> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const options: Options = { ...this.baseOptions(), abortController, includePartialMessages: true };
    if (req.serverTools && req.serverTools.length > 0) {
      options.tools = [...req.serverTools];
      options.canUseTool = allowOnly(req.serverTools);
      options.maxTurns = SERVER_TOOL_MAX_TURNS;
    }
    const mcp = req.mcpServers && Object.keys(req.mcpServers).length > 0 ? req.mcpServers : undefined;
    if (mcp) {
      const servers: Record<string, McpServerConfig> = {};
      for (const [name, spec] of Object.entries(mcp)) {
        // alwaysLoad: the tools must be in the very first prompt, not
        // deferred behind tool search.
        servers[name] = { type: "http", url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}), alwaysLoad: true };
      }
      options.mcpServers = servers;
      // A request's MCP headers carry its tokens: keep them off the command
      // line (readable by every user of the machine) when the CLI can take
      // them over stdin instead.
      options.mcpServersDelivery = await this.mcpDelivery();
      options.canUseTool = allowMcp(mcp, req.serverTools ?? []);
      options.maxTurns = Math.max(options.maxTurns ?? 1, MCP_MAX_TURNS);
    }
    options.model = claudeLongContextModel(req.model ?? "");
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
    // Ids of MCP tool calls surfaced so far; only their results are reported.
    const mcpCalls = new Set<string>();
    // The plan's usage windows, latest report per window.
    const limits = new Map<string, PlanLimit>();
    const usedUp = (): PlanLimit | undefined => [...limits.values()].find((l) => l.status === "rejected");

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
          const raw = msg.message as { model?: string; stop_reason?: string | null; content?: unknown };
          if (typeof raw.model === "string") model = raw.model;
          if (typeof raw.stop_reason === "string") stopReason = raw.stop_reason;
          if (mcp && Array.isArray(raw.content)) {
            for (const block of raw.content as Array<Record<string, unknown>>) {
              if (block?.["type"] !== "tool_use" || typeof block["name"] !== "string" || typeof block["id"] !== "string") continue;
              const parsed = parseMcpToolName(block["name"] as string);
              if (!parsed || !mcp[parsed.server]) continue;
              mcpCalls.add(block["id"] as string);
              yield { type: "tool_use", id: block["id"] as string, name: parsed.tool, serverName: parsed.server, input: block["input"] ?? {} };
            }
          }
        } else if (msg.type === "user" && msg.parent_tool_use_id === null && mcp) {
          const content = (msg.message as { content?: unknown }).content;
          if (!Array.isArray(content)) continue;
          for (const block of content as Array<Record<string, unknown>>) {
            if (block?.["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
            const id = block["tool_use_id"] as string;
            if (!mcpCalls.has(id)) continue;
            yield { type: "tool_result", toolUseId: id, isError: block["is_error"] === true, content: flattenToolResultContent(block["content"]) };
          }
        } else if (msg.type === "rate_limit_event") {
          for (const limit of planLimits(msg.rate_limit_info)) limits.set(limit.window, limit);
        } else if (msg.type === "result") {
          result = msg;
        }
      }
    } catch (err) {
      throw this.failure(err, usedUp());
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }

    if (req.signal?.aborted) return;
    if (!result) throw new ProviderError(this.id, "engine terminated without producing a result");
    if (result.subtype === "success" && result.is_error) {
      throw this.failure(new Error(result.result || "engine reported an error"), usedUp());
    }
    if (result.subtype !== "success") {
      const detail = "errors" in result && result.errors.length > 0 ? result.errors.join("; ") : result.subtype;
      throw classifyProviderFailure(this.id, this.loginCommand, new Error(`engine error: ${detail}`));
    }
    // Some engine paths emit no partial events; fall back to the final text.
    if (!sawText && result.result) yield { type: "text", text: result.result };
    // Every tool the model asked for already ran inside the turn; the caller
    // never has a tool_use to execute, so the turn is over.
    if (stopReason === "tool_use") stopReason = "end_turn";

    const contextWindow = claudeResultContextWindow(result.modelUsage, model);
    if (model && contextWindow) this.observedContexts.set(model, contextWindow);
    if (options.model?.endsWith("[1m]") && contextWindow !== undefined && contextWindow < 1_000_000) {
      throw new ProviderError(this.id, `requested 1M context for ${options.model}, but the CLI reported ${contextWindow} tokens`);
    }
    yield {
      type: "done",
      ...(contextWindow ? { contextWindow } : {}),
      usage: mapUsage(result.usage as unknown as Record<string, unknown>),
      ...(result.total_cost_usd !== undefined ? { costUsd: result.total_cost_usd } : {}),
      ...(model ? { model } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(limits.size > 0 ? { limits: [...limits.values()] } : {}),
    };
  }

  /** A turn's failure, typed: a used-up plan is a UsageLimitError with its reset time. */
  private failure(err: unknown, usedUp: PlanLimit | undefined): Error {
    const message = (err instanceof Error ? err.message : String(err)).replace(/^Claude Code returned an error result: /, "");
    if (usedUp || looksLikeUsageLimit(message)) return new UsageLimitError(this.id, usedUp?.resetsAt, message);
    return classifyProviderFailure(this.id, this.loginCommand, err);
  }

  /** Is this account signed in? Asks the CLI itself (`claude auth status`), no model call. */
  async status(): Promise<ProviderStatus> {
    const out = await runCommand(this.executable, ["auth", "status", "--json"], { env: this.accountEnv(), cwd: this.workDir });
    let parsed: { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown } | undefined;
    try {
      parsed = JSON.parse(out.stdout) as typeof parsed;
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed.loggedIn !== "boolean") {
      // an older CLI without `auth status`: nothing to go by short of a turn
      return { detail: (out.stderr || out.stdout).trim().split("\n")[0]?.slice(0, 200) || "claude auth status gave no answer" };
    }
    return {
      signedIn: parsed.loggedIn,
      ...(typeof parsed.email === "string" ? { account: parsed.email } : {}),
      ...(typeof parsed.subscriptionType === "string" ? { plan: parsed.subscriptionType } : {}),
    };
  }

  /**
   * The account's plan windows right now — what `/usage` shows — read over
   * a short-lived control session, no model call. Undefined when the CLI
   * cannot say (an API-key login, an older CLI).
   */
  async limits(): Promise<PlanUsage | undefined> {
    const abortController = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const idle = (async function* (): AsyncGenerator<SDKUserMessage> {
      await gate;
    })();
    const q = query({ prompt: idle, options: { ...this.baseOptions(), abortController } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // the SDK marks this call experimental and may rename it
      const ask = (q as unknown as Record<string, ((opts?: { skipBehaviors?: boolean }) => Promise<unknown>) | undefined>)["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"];
      if (typeof ask !== "function") return undefined;
      const usage = (await Promise.race([
        // skip the local-transcript scan; only the plan windows are wanted
        ask.call(q, { skipBehaviors: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out reading plan usage")), 15_000);
          timer.unref?.();
        }),
      ])) as { subscription_type?: unknown; rate_limits?: Record<string, unknown> | null };
      if (!usage.rate_limits) return undefined;
      const windows: PlanLimit[] = [];
      for (const [window, raw] of Object.entries(usage.rate_limits)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const row = raw as { utilization?: unknown; resets_at?: unknown };
        if (typeof row.utilization !== "number" || !("resets_at" in row)) continue;
        const resetsAt = typeof row.resets_at === "string" ? Date.parse(row.resets_at) : NaN;
        windows.push({
          window,
          utilization: row.utilization / 100,
          ...(Number.isFinite(resetsAt) ? { resetsAt: Math.floor(resetsAt / 1000) } : {}),
          status: row.utilization >= 100 ? "rejected" : "allowed",
        });
      }
      return { ...(typeof usage.subscription_type === "string" ? { plan: usage.subscription_type } : {}), windows };
    } catch (err) {
      debug(this.id, "could not read plan usage", err);
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
      release();
      abortController.abort();
    }
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
      // Yagami's safe default selects the live Sonnet alias, not the CLI's
      // account default. Keep the catalog honest about what execution requests.
      const catalog = models.flatMap((row) => {
        if (row.value !== "default") return [row];
        const sonnet = models.find((candidate) => candidate.value === "sonnet");
        return sonnet ? [{ ...sonnet, value: "default", displayName: "Default (Sonnet, 1M)" }] : [];
      });
      return catalog.map((m) => ({
        id: m.value,
        display_name: m.displayName,
        ...(claudeLongContextModel(m.value).endsWith("[1m]")
          ? { context_window: 1_000_000, context_window_source: "requested" as const }
          : {}),
        ...(m.resolvedModel && this.observedContexts.has(m.resolvedModel)
          ? { context_window: this.observedContexts.get(m.resolvedModel)!, context_window_source: "observed" as const }
          : {}),
        ...(m.description ? { description: m.description } : {}),
        ...(m.resolvedModel ? { resolved_model: m.resolvedModel } : {}),
        ...(m.supportedEffortLevels?.length
          ? { reasoning_efforts: m.supportedEffortLevels.map((id) => ({ id })) }
          : {}),
        ...(m.supportsAdaptiveThinking ? { supports_adaptive_thinking: true } : {}),
        ...(m.supportsFastMode ? { supports_fast_mode: true } : {}),
        ...(m.supportsAutoMode ? { supports_auto_mode: true } : {}),
        ...(m.value === "default" ? { is_default: true } : {}),
      }));
    } catch (err) {
      throw classifyProviderFailure(this.id, this.loginCommand, err);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      abortController.abort();
    }
  }

  private delivery: Promise<"argv" | "initialize"> | undefined;
  /**
   * `initialize` sends MCP servers over stdin, but only a CLI at least as new
   * as the one the SDK was built with understands it; older ones exit at
   * startup. Checked once per provider.
   */
  private mcpDelivery(): Promise<"argv" | "initialize"> {
    this.delivery ??= (async () => {
      const bundled = bundledClaudeVersion();
      const binary = (await this.version())?.match(/\d+\.\d+\.\d+/)?.[0];
      return bundled && binary && versionAtLeast(binary, bundled) ? "initialize" : "argv";
    })();
    return this.delivery;
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
  return sdkPackage()?.version;
}

/** The Claude Code build the bundled Agent SDK was made with. */
function bundledClaudeVersion(): string | undefined {
  return sdkPackage()?.claudeCodeVersion;
}

/** a ≥ b, for dotted numeric versions. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

let sdkPackageCache: { version?: string; claudeCodeVersion?: string } | null | undefined;
function sdkPackage(): { version?: string; claudeCodeVersion?: string } | undefined {
  if (sdkPackageCache !== undefined) return sdkPackageCache ?? undefined;
  sdkPackageCache = readSdkPackage() ?? null;
  return sdkPackageCache ?? undefined;
}

function readSdkPackage(): { version?: string; claudeCodeVersion?: string } | undefined {
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve("@anthropic-ai/claude-agent-sdk");
    let dir = path.dirname(entry);
    for (let i = 0; i < 4; i += 1) {
      const pkg = path.join(dir, "package.json");
      if (fs.existsSync(pkg)) {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string; version?: string; claudeCodeVersion?: string };
        if (parsed.name === "@anthropic-ai/claude-agent-sdk") return { version: parsed.version, claudeCodeVersion: parsed.claudeCodeVersion };
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

/** The windows one `rate_limit_event` describes. */
export function planLimits(info: unknown): PlanLimit[] {
  const raw = (info ?? {}) as Record<string, unknown>;
  const status = (value: unknown): PlanLimit["status"] | undefined =>
    value === "rejected" ? "rejected" : value === "allowed_warning" ? "warning" : value === "allowed" ? "allowed" : undefined;
  const one = (window: string, row: Record<string, unknown>): PlanLimit => {
    const s = status(row["status"]);
    return {
      window,
      ...(typeof row["utilization"] === "number" ? { utilization: row["utilization"] } : {}),
      ...(typeof row["resetsAt"] === "number" ? { resetsAt: row["resetsAt"] } : {}),
      ...(s ? { status: s } : {}),
    };
  };
  // newer CLIs list every window; older ones report only the one that moved
  const windows = raw["unifiedWindows"];
  if (windows && typeof windows === "object" && !Array.isArray(windows)) {
    const rows = Object.entries(windows as Record<string, unknown>).filter(([, row]) => row && typeof row === "object");
    if (rows.length > 0) return rows.map(([window, row]) => one(window, row as Record<string, unknown>));
  }
  return typeof raw["rateLimitType"] === "string" ? [one(raw["rateLimitType"], raw)] : [];
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
