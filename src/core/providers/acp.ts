import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { ContentBlock as AcpContentBlock } from "@agentclientprotocol/sdk";
import { resolveExecutable } from "../executable.js";
import { classifyProviderFailure, looksLikeAuthFailure, AuthRequiredError, ProviderError } from "../errors.js";
import { declineInput, elicitationRequest, elicitationResponse } from "../interaction.js";
import type { EngineModel } from "../models.js";
import type {
  AgentEvent,
  Provider,
  ProviderCapabilities,
  ProviderSession,
  ProviderSessionOptions,
  SessionPermissionDecision,
  SessionPermissionRequest,
  SessionPlan,
  SessionPlanEntry,
  SessionProvider,
  TurnEvent,
  TurnRequest,
} from "../provider.js";
import type { ContentBlockParam, Usage } from "../types.js";
import { AsyncQueue } from "./queue.js";
import { VERSION } from "../../version.js";

export interface AcpHandlers {
  onUpdate?: (n: SessionNotification) => void;
  onPermission?: (p: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  onInput?: (p: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
}

/** A live ACP agent process plus its negotiated connection. */
export interface AcpConnection {
  agent: ClientSideConnection;
  init: InitializeResponse;
  setHandlers(handlers: AcpHandlers): void;
  close(): void;
}

export interface AcpProviderOptions {
  id: string;
  label: string;
  /** Executable name or path, resolved like any other CLI. */
  command: string;
  args?: string[];
  /** Explicit executable path override (wins over `command`). */
  path?: string;
  env?: Record<string, string>;
  workDir?: string;
  appName?: string;
  /** Id of the session config option that selects the model (default "model"). */
  modelConfigId?: string;
  loginCommand?: string;
  installHint?: string;
  /** Test seam: replaces process spawning. */
  connect?: (cwd: string) => Promise<AcpConnection>;
}

/** Pick the most conservative option an agent offers for a permission ask. */
export function rejectOption(p: RequestPermissionRequest): RequestPermissionResponse {
  const pick =
    p.options.find((o) => o.kind === "reject_once") ??
    p.options.find((o) => o.kind === "reject_always") ??
    p.options[0];
  if (!pick) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: pick.optionId } };
}

/**
 * Any agent speaking the Agent Client Protocol over stdio — OpenCode,
 * Gemini CLI, Copilot, Cursor, Qwen Code, Kimi, Goose, and anything in the
 * ACP registry. One adapter, many harnesses.
 */
export class AcpProvider implements SessionProvider {
  readonly id: string;
  readonly label: string;
  readonly executable: string;
  readonly loginCommand: string;
  readonly capabilities: ProviderCapabilities = {
    resume: true,
    fork: false,
    images: true,
    documents: false,
    systemPrompt: false,
    thinking: false,
    effort: false,
    streaming: "tokens",
    serverTools: false,
  };
  readonly sessionCapabilities = { fork: false } as const;

  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly workDir: string;
  private readonly appName: string;
  private readonly modelConfigId: string;
  private readonly connectImpl: (cwd: string) => Promise<AcpConnection>;

  constructor(options: AcpProviderOptions) {
    this.id = options.id;
    this.label = options.label;
    this.loginCommand = options.loginCommand ?? `${options.command} (sign in per its docs)`;
    this.executable = options.connect
      ? options.path ?? options.command
      : resolveExecutable(options.id, options.command, options.installHint ?? `Install \`${options.command}\` and sign in.`, {
          ...(options.path ? { explicit: options.path } : {}),
        });
    this.args = options.args ?? [];
    this.env = { ...process.env, ...options.env };
    this.workDir = options.workDir ?? path.join(os.tmpdir(), "yagami-workspace");
    this.appName = options.appName ?? "yagami";
    this.modelConfigId = options.modelConfigId ?? "model";
    this.connectImpl = options.connect ?? ((cwd) => this.spawnConnection(cwd));
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  private spawnConnection(cwd: string): Promise<AcpConnection> {
    return new Promise<AcpConnection>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.executable, this.args, { cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        reject(classifyProviderFailure(this.id, this.loginCommand, err));
        return;
      }
      let stderr = "";
      const noteNoise = (d: string) => {
        stderr += d;
        if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
      };
      child.stderr?.on("data", (d: Buffer) => noteNoise(d.toString()));
      let handlers: AcpHandlers = {};
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(jsonLinesOnly(child.stdout!, noteNoise)) as ReadableStream<Uint8Array>,
      );
      const agent = new ClientSideConnection(
        () => ({
          requestPermission: (p) => (handlers.onPermission ? handlers.onPermission(p) : rejectOption(p)),
          unstable_createElicitation: (p) =>
            handlers.onInput ? handlers.onInput(p) : Promise.resolve({ action: "decline" }),
          unstable_completeElicitation: () => {},
          sessionUpdate: (n) => {
            handlers.onUpdate?.(n);
          },
        }),
        stream,
      );
      let settled = false;
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(classifyProviderFailure(this.id, this.loginCommand, err));
      });
      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        reject(classifyProviderFailure(this.id, this.loginCommand, new Error(`${this.executable} exited with code ${code}${stderr ? `: ${stderr.trim().slice(-400)}` : ""}`)));
      });
      agent
        .initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: this.appName, version: VERSION },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            session: { configOptions: { boolean: {} } },
            plan: {},
            elicitation: { form: {}, url: {} },
          },
        })
        .then((init) => {
          if (settled) return;
          settled = true;
          resolve({
            agent,
            init,
            setHandlers: (h) => {
              handlers = h;
            },
            close: () => {
              child.kill("SIGTERM");
            },
          });
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          reject(this.classify(err, stderr));
        });
    });
  }

  private classify(err: unknown, context = ""): Error {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: number } | undefined)?.code;
    // -32000 is ACP's "authentication required" error code.
    if (code === -32000 || looksLikeAuthFailure(message) || looksLikeAuthFailure(context)) {
      return new AuthRequiredError(this.id, this.loginCommand, message.slice(0, 200));
    }
    return classifyProviderFailure(this.id, this.loginCommand, err);
  }

  async *run(req: TurnRequest): AsyncGenerator<TurnEvent, void, undefined> {
    const conn = await this.connectImpl(this.workDir);
    const queue = new AsyncQueue<TurnEvent>();
    let sessionId: string | undefined;
    let costUsd: number | undefined;
    const onAbort = () => {
      if (sessionId) void conn.agent.cancel({ sessionId }).catch(() => {});
    };
    try {
      let configOptions: SessionConfigOption[] | null | undefined;
      let modes: { currentModeId?: string; availableModes?: Array<{ id: string }> } | null | undefined;
      if (req.resume) {
        if (!supportsResume(conn.init)) {
          throw new ProviderError(this.id, "this agent cannot resume sessions; replaying the transcript instead");
        }
        const resumed = await conn.agent.resumeSession({ sessionId: req.resume, cwd: this.workDir }).catch((err) => {
          throw this.classify(err);
        });
        sessionId = req.resume;
        configOptions = resumed.configOptions;
        modes = resumed.modes as typeof modes;
      } else {
        const created = await conn.agent.newSession({ cwd: this.workDir, mcpServers: [] }).catch((err) => {
          throw this.classify(err);
        });
        sessionId = created.sessionId;
        configOptions = created.configOptions;
        modes = created.modes as typeof modes;
      }
      yield { type: "session", sessionId };

      // Hardening: prefer a read-only/plan mode when the agent offers one.
      const plan = modes?.availableModes?.find((m) => /^(plan|read[-_]?only|ask)$/i.test(m.id));
      if (plan && modes?.currentModeId !== plan.id) {
        await conn.agent.setSessionMode({ sessionId, modeId: plan.id }).catch(() => {});
      }
      if (req.model) await this.selectModel(conn, sessionId, configOptions, req.model);
      if (req.effort) await this.selectEffort(conn, sessionId, configOptions, req.effort);

      const sid = sessionId;
      conn.setHandlers({
        onPermission: async (p) => rejectOption(p),
        onUpdate: (n) => {
          if (n.sessionId !== sid) return;
          const u = n.update;
          if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
            queue.push({ type: "text", text: u.content.text });
          } else if (u.sessionUpdate === "agent_thought_chunk" && u.content.type === "text") {
            queue.push({ type: "thinking", text: u.content.text });
          } else if (u.sessionUpdate === "usage_update") {
            const cost = (u as { cost?: { amount?: number; currency?: string } | null }).cost;
            if (cost && typeof cost.amount === "number" && (cost.currency ?? "USD") === "USD") costUsd = cost.amount;
          }
        },
      });
      req.signal?.addEventListener("abort", onAbort, { once: true });

      conn.agent
        .prompt({ sessionId, prompt: toAcpBlocks(req.prompt, req.media ?? [], this.id) })
        .then((res) => {
          queue.push({
            type: "done",
            usage: mapAcpUsage((res.usage ?? undefined) as Record<string, unknown> | undefined),
            ...(costUsd !== undefined ? { costUsd } : {}),
            stopReason: mapStopReason(res.stopReason),
          });
          queue.end();
        })
        .catch((err) => queue.fail(this.classify(err)));

      for await (const ev of queue) yield ev;
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      conn.close();
    }
  }

  /**
   * A live, interactive ACP session: the agent runs warm in the project
   * directory with ITS OWN defaults — no plan-mode hardening, no forced
   * config. Tool calls stream as normalized events and permission requests
   * go to the host's handler, exactly as the agent's own client would ask.
   */
  openSession(options: ProviderSessionOptions): ProviderSession {
    return new AcpAgentSession({
      id: this.id,
      modelConfigId: this.modelConfigId,
      connect: (cwd) => this.connectImpl(cwd),
      classify: (err, ctx) => this.classify(err, ctx),
      selectModel: (conn, sessionId, configOptions, model) => this.selectModel(conn, sessionId, configOptions, model),
      selectEffort: (conn, sessionId, configOptions, effort) => this.selectEffort(conn, sessionId, configOptions, effort),
      options,
    });
  }

  private async selectModel(
    conn: AcpConnection,
    sessionId: string,
    configOptions: SessionConfigOption[] | null | undefined,
    model: string,
  ): Promise<void> {
    const option =
      configOptions?.find((o) => o.id === this.modelConfigId) ?? configOptions?.find((o) => o.category === "model");
    if (!option || option.type !== "select") {
      throw new ProviderError(this.id, `cannot select model "${model}": the agent exposes no model option (omit the model to use its default)`);
    }
    if (option.currentValue === model) return;
    await conn.agent.setSessionConfigOption({ sessionId, configId: option.id, value: model }).catch((err) => {
      throw this.classify(err);
    });
  }

  private async selectEffort(
    conn: AcpConnection,
    sessionId: string,
    configOptions: SessionConfigOption[] | null | undefined,
    effort: string,
  ): Promise<void> {
    const option = configOptions?.find(
      (candidate) =>
        candidate.category === "thought_level" ||
        /^(?:thought[_-]?level|reasoning[_-]?effort|effort)$/i.test(candidate.id),
    );
    if (!option || option.type !== "select" || option.currentValue === effort) return;
    if (!flattenSelectOptions(option).some((candidate) => candidate.value === effort)) return;
    await conn.agent.setSessionConfigOption({ sessionId, configId: option.id, value: effort }).catch((err) => {
      throw this.classify(err);
    });
  }

  async listModels(): Promise<EngineModel[]> {
    const conn = await this.connectImpl(this.workDir);
    try {
      const created = await conn.agent.newSession({ cwd: this.workDir, mcpServers: [] }).catch((err) => {
        throw this.classify(err);
      });
      const option =
        created.configOptions?.find((o) => o.id === this.modelConfigId) ??
        created.configOptions?.find((o) => o.category === "model");
      if (!option || option.type !== "select") return [];
      const effortOption = created.configOptions?.find(
        (candidate) =>
          candidate.type === "select" &&
          (candidate.category === "thought_level" ||
            /^(?:thought[_-]?level|reasoning[_-]?effort|effort)$/i.test(candidate.id)),
      );
      const efforts = effortOption?.type === "select"
        ? flattenSelectOptions(effortOption).map((entry) => ({
            id: entry.value,
            ...(entry.description ? { description: entry.description } : {}),
          }))
        : [];
      return flattenSelectOptions(option).map((o) => ({
        id: o.value,
        display_name: o.name,
        ...(o.description ? { description: o.description } : {}),
        ...(efforts.length > 0 ? { reasoning_efforts: efforts } : {}),
        ...(effortOption?.type === "select" ? { default_reasoning_effort: effortOption.currentValue } : {}),
      }));
    } finally {
      conn.close();
    }
  }

  /**
   * The agent's self-reported name/version from the ACP handshake. When the
   * handshake fails (wrong binary, version too old for ACP), falls back to
   * `--version` and says so, because that is exactly what `doctor` needs.
   */
  async version(): Promise<string | undefined> {
    let handshakeError: string | undefined;
    try {
      const conn = await this.connectImpl(this.workDir);
      try {
        const info = conn.init.agentInfo;
        if (info?.version) return `${info.name ?? this.id} ${info.version}`;
        return `${this.id} (ACP ok)`;
      } finally {
        conn.close();
      }
    } catch (err) {
      handshakeError = (err instanceof Error ? err.message : String(err)).split("\n")[0]?.slice(0, 120);
    }
    let plain: string | undefined;
    try {
      const out = spawnSync(this.executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
      plain = out.stdout?.trim().split("\n")[0] || undefined;
    } catch {
      plain = undefined;
    }
    return `${plain ?? "unknown version"} ⚠ no ACP handshake (${handshakeError ?? "unknown error"}) — too old, or a different program with the same name?`;
  }
}

interface AcpSessionConfig {
  id: string;
  modelConfigId: string;
  connect: (cwd: string) => Promise<AcpConnection>;
  classify: (err: unknown, context?: string) => Error;
  selectModel: (
    conn: AcpConnection,
    sessionId: string,
    configOptions: SessionConfigOption[] | null | undefined,
    model: string,
  ) => Promise<void>;
  selectEffort: (
    conn: AcpConnection,
    sessionId: string,
    configOptions: SessionConfigOption[] | null | undefined,
    effort: string,
  ) => Promise<void>;
  options: ProviderSessionOptions;
}

/** One warm ACP agent process, verbatim, across turns. */
class AcpAgentSession implements ProviderSession {
  readonly provider: string;

  private conn: AcpConnection | undefined;
  private sessionId: string | undefined;
  private queue: AsyncQueue<AgentEvent> | null = null;
  private opening: Promise<void> | undefined;
  private closed = false;
  private costUsd: number | undefined;
  /** Updates often omit title/kind — remember them from the start event. */
  private readonly toolMeta = new Map<string, { name: string; title?: string; kind?: string }>();

  constructor(private readonly cfg: AcpSessionConfig) {
    this.provider = cfg.id;
  }

  get id(): string | undefined {
    return this.sessionId;
  }

  private ensureOpen(): Promise<void> {
    this.opening ??= this.open();
    return this.opening;
  }

  private async open(): Promise<void> {
    const { options } = this.cfg;
    const conn = await this.cfg.connect(options.cwd);
    this.conn = conn;
    let configOptions: SessionConfigOption[] | null | undefined;
    if (options.resume && supportsResume(conn.init)) {
      const resumed = await conn.agent
        .resumeSession({ sessionId: options.resume, cwd: options.cwd })
        .catch((err) => {
          throw this.cfg.classify(err);
        });
      this.sessionId = options.resume;
      configOptions = resumed.configOptions;
    } else {
      const created = await conn.agent.newSession({ cwd: options.cwd, mcpServers: [] }).catch((err) => {
        throw this.cfg.classify(err);
      });
      this.sessionId = created.sessionId;
      configOptions = created.configOptions;
    }
    const sessionId = this.sessionId;
    // verbatim by default: only an explicit native.mode changes the agent's mode
    const mode = (options.native as { mode?: string } | undefined)?.mode;
    if (mode) await conn.agent.setSessionMode({ sessionId, modeId: mode }).catch(() => {});
    if (options.model) await this.cfg.selectModel(conn, sessionId, configOptions, options.model);
    if (options.effort) await this.cfg.selectEffort(conn, sessionId, configOptions, options.effort);
    conn.setHandlers({
      onPermission: (p) => this.onPermission(p),
      onInput: (p) => this.onInput(p),
      onUpdate: (n) => this.onUpdate(n),
    });
  }

  private async onPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const toolCall = p.toolCall as { title?: string; kind?: string; rawInput?: unknown } | undefined;
    const request: SessionPermissionRequest = {
      provider: this.provider,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      tool: toolCall?.title ?? "tool",
      ...(toolCall?.kind ? { kind: toolCall.kind } : {}),
      ...(toolCall?.title ? { title: toolCall.title } : {}),
      input: toolCall?.rawInput,
      raw: p,
    };
    let decision: SessionPermissionDecision = "deny";
    try {
      decision = await this.cfg.options.permissions.decide(request);
    } catch {
      // an unanswerable ask is a denied ask
    }
    this.queue?.push({ type: "permission", request, decision });
    const preferred: Record<SessionPermissionDecision, string[]> = {
      allow: ["allow_once", "allow_always"],
      allow_always: ["allow_always", "allow_once"],
      deny: ["reject_once", "reject_always"],
      deny_always: ["reject_always", "reject_once"],
    };
    for (const kind of preferred[decision]) {
      const option = p.options.find((o) => o.kind === kind);
      if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
    }
    return rejectOption(p);
  }

  private async onInput(p: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const request = elicitationRequest(
      this.provider,
      this.sessionId,
      p as unknown as Record<string, unknown>,
    );
    const handler = this.cfg.options.input;
    let response = declineInput();
    if (handler) {
      try {
        response = await handler.respond(request);
      } catch {
        response = { action: "cancel" };
      }
    }
    return elicitationResponse(response) as CreateElicitationResponse;
  }

  private onUpdate(n: SessionNotification): void {
    if (n.sessionId !== this.sessionId) return;
    const u = n.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") this.queue?.push({ type: "text", text: u.content.text });
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") this.queue?.push({ type: "thinking", text: u.content.text });
        break;
      case "plan":
        this.queue?.push({ type: "plan", plan: acpPlan(u as unknown as Record<string, unknown>) });
        break;
      case "plan_update":
        this.queue?.push({ type: "plan", plan: acpPlan((u as unknown as { plan?: Record<string, unknown> }).plan ?? {}) });
        break;
      case "plan_removed":
        this.queue?.push({
          type: "plan",
          plan: {
            ...(typeof (u as unknown as { planId?: unknown }).planId === "string"
              ? { id: (u as unknown as { planId: string }).planId }
              : {}),
            removed: true,
          },
        });
        break;
      case "tool_call": {
        const t = u as { toolCallId: string; title?: string; kind?: string; rawInput?: unknown };
        const meta = { name: t.kind ?? "tool", ...(t.title ? { title: t.title } : {}), ...(t.kind ? { kind: t.kind } : {}) };
        this.toolMeta.set(t.toolCallId, meta);
        this.queue?.push({
          type: "tool_call",
          id: t.toolCallId,
          status: "started",
          ...meta,
          ...(t.rawInput !== undefined ? { input: t.rawInput } : {}),
        });
        break;
      }
      case "tool_call_update": {
        const t = u as { toolCallId: string; status?: string; title?: string; kind?: string; rawOutput?: unknown };
        const known = this.toolMeta.get(t.toolCallId);
        const meta = {
          name: t.kind ?? known?.name ?? "tool",
          ...(t.title ?? known?.title ? { title: t.title ?? known?.title } : {}),
          ...(t.kind ?? known?.kind ? { kind: t.kind ?? known?.kind } : {}),
        };
        this.queue?.push({
          type: "tool_call",
          id: t.toolCallId,
          status: t.status === "completed" ? "completed" : t.status === "failed" ? "failed" : "updated",
          ...meta,
          ...(t.rawOutput !== undefined ? { output: t.rawOutput } : {}),
        });
        break;
      }
      case "usage_update": {
        const cost = (u as { cost?: { amount?: number; currency?: string } | null }).cost;
        if (cost && typeof cost.amount === "number" && (cost.currency ?? "USD") === "USD") this.costUsd = cost.amount;
        break;
      }
      default:
        this.queue?.push({ type: "raw", provider: this.provider, payload: u });
        break;
    }
  }

  async *send(input: string | ContentBlockParam[]): AsyncGenerator<AgentEvent, void, undefined> {
    if (this.closed) throw new ProviderError(this.provider, "session is closed");
    if (this.queue) throw new ProviderError(this.provider, "a turn is already running");
    await this.ensureOpen();
    const sessionId = this.sessionId!;
    const text = typeof input === "string" ? input : input.filter((b) => b.type === "text").map((b) => (b as { text?: string }).text ?? "").join("\n");
    const media = typeof input === "string" ? [] : input.filter((b) => b.type === "image");

    const queue = new AsyncQueue<AgentEvent>();
    this.queue = queue;
    this.costUsd = undefined;
    this.conn!.agent
      .prompt({ sessionId, prompt: toAcpBlocks(text, media, this.provider) })
      .then((res) => {
        queue.push({
          type: "done",
          usage: mapAcpUsage((res.usage ?? undefined) as Record<string, unknown> | undefined),
          ...(this.costUsd !== undefined ? { costUsd: this.costUsd } : {}),
          stopReason: mapStopReason(res.stopReason),
        });
        queue.end();
      })
      .catch((err) => queue.fail(this.cfg.classify(err)));
    try {
      yield { type: "session", sessionId };
      for await (const event of queue) yield event;
    } finally {
      if (this.queue === queue) this.queue = null;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId || !this.conn) return;
    await this.conn.agent.cancel({ sessionId: this.sessionId }).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue?.fail(new ProviderError(this.provider, "session closed"));
    this.queue = null;
    this.conn?.close();
    this.conn = undefined;
  }
}

function acpPlan(raw: Record<string, unknown>): SessionPlan {
  const entries = Array.isArray(raw["entries"])
    ? raw["entries"].flatMap((value) => {
        const entry = value as Record<string, unknown>;
        if (typeof entry["content"] !== "string") return [];
        const item: SessionPlanEntry = {
          content: entry["content"],
          status:
            entry["status"] === "completed"
              ? "completed"
              : entry["status"] === "in_progress"
                ? "in_progress"
                : "pending",
          ...(["high", "medium", "low"].includes(String(entry["priority"]))
            ? { priority: entry["priority"] as SessionPlanEntry["priority"] }
            : {}),
        };
        return [item];
      })
    : undefined;
  return {
    ...(typeof raw["planId"] === "string" ? { id: raw["planId"] } : {}),
    ...(entries ? { entries } : {}),
    ...(typeof raw["content"] === "string" ? { markdown: raw["content"] } : {}),
    ...(typeof raw["uri"] === "string" ? { uri: raw["uri"] } : {}),
  };
}

function supportsResume(init: InitializeResponse): boolean {
  const caps = init.agentCapabilities as { sessionCapabilities?: { resume?: unknown } } | undefined;
  return caps?.sessionCapabilities?.resume !== undefined;
}

/** Select options may be flat or grouped; return the leaves. */
function flattenSelectOptions(option: SessionConfigOption & { type: "select" }): Array<{ value: string; name: string; description?: string | null }> {
  const raw = (option as { options?: unknown }).options;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ value: string; name: string; description?: string | null }> = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    if (typeof entry["value"] === "string") {
      out.push({ value: entry["value"], name: String(entry["name"] ?? entry["value"]), description: entry["description"] as string | undefined });
    } else if (Array.isArray(entry["options"])) {
      for (const leaf of entry["options"] as Array<Record<string, unknown>>) {
        if (typeof leaf["value"] === "string") {
          out.push({ value: leaf["value"], name: String(leaf["name"] ?? leaf["value"]), description: leaf["description"] as string | undefined });
        }
      }
    }
  }
  return out;
}

function toAcpBlocks(text: string, media: ContentBlockParam[], providerId: string): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];
  for (const block of media) {
    if (block.type !== "image") continue;
    const source = block["source"] as { type?: string; data?: string; media_type?: string } | undefined;
    if (source?.type !== "base64" || typeof source.data !== "string") {
      throw new ProviderError(providerId, "only base64 image sources are supported (URL images are not fetched)");
    }
    blocks.push({ type: "image", data: source.data, mimeType: source.media_type ?? "image/png" });
  }
  if (text.length > 0 || blocks.length === 0) blocks.push({ type: "text", text });
  return blocks;
}

function mapAcpUsage(u: Record<string, unknown> | undefined): Usage {
  const num = (k: string) => (typeof u?.[k] === "number" ? (u[k] as number) : 0);
  return {
    input_tokens: num("inputTokens"),
    output_tokens: num("outputTokens"),
    cache_read_input_tokens: num("cachedReadTokens") || num("cacheReadTokens"),
    cache_creation_input_tokens: num("cachedWriteTokens") || num("cacheWriteTokens"),
  };
}

function mapStopReason(reason: string): string {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

/**
 * Pass only JSON-looking lines through to the protocol reader. Anything
 * else (banners, usage text from a wrong binary) is reported as noise
 * instead of tripping the SDK's parser.
 */
function jsonLinesOnly(input: NodeJS.ReadableStream, onNoise: (line: string) => void): PassThrough {
  const out = new PassThrough();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (line.trimStart().startsWith("{")) out.write(`${line}\n`);
    else if (line.trim()) onNoise(`${line}\n`);
  });
  rl.on("close", () => out.end());
  return out;
}
