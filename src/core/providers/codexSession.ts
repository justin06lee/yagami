import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { AuthRequiredError, classifyProviderFailure, looksLikeAuthFailure, ProviderError } from "../errors.js";
import { declineInput, elicitationRequest, elicitationResponse } from "../interaction.js";
import type {
  AgentEvent,
  ProviderSession,
  ProviderSessionOptions,
  SessionPermissionDecision,
  SessionPermissionRequest,
  SessionInputField,
  SessionInputRequest,
  SessionInputResponse,
  SessionPlanStatus,
} from "../provider.js";
import type { ContentBlockParam, Usage } from "../types.js";
import { writeTempImages } from "./codex.js";
import { AsyncQueue } from "./queue.js";
import { VERSION } from "../../version.js";

/**
 * A live, interactive Codex session over `codex app-server` — the same
 * engine the Codex TUI runs on, warm across turns. Nothing is overridden
 * unless asked: approval policy, sandbox, and instructions all come from the
 * user's own `~/.codex/config.toml`, and approval requests are forwarded to
 * the host's permission handler exactly as the TUI would prompt.
 *
 * Protocol: JSON-RPC over stdio, thread/turn API (`thread/start`,
 * `turn/start`, item notifications, server-initiated approval requests).
 */

interface CodexSessionConfig {
  executable: string;
  env: NodeJS.ProcessEnv;
  loginCommand: string;
  options: ProviderSessionOptions;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

/** Codex native overrides accepted via ProviderSessionOptions.native. */
interface CodexNative {
  sandbox?: string;
  approvalPolicy?: string;
  config?: Record<string, unknown>;
}

export class CodexAgentSession implements ProviderSession {
  readonly provider = "codex";

  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private threadId: string | undefined;
  private currentTurnId: string | undefined;
  private queue: AsyncQueue<AgentEvent> | null = null;
  private lastUsage: Usage | undefined;
  private opening: Promise<void> | undefined;
  private closed = false;
  /** Item text already emitted as deltas, so item/completed only fills gaps. */
  private readonly emitted = new Map<string, number>();

  constructor(private readonly config: CodexSessionConfig) {}

  get id(): string | undefined {
    return this.threadId;
  }

  private fail(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.queue?.fail(err);
    this.queue = null;
  }

  private classify(err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeAuthFailure(message)) {
      return new AuthRequiredError("codex", this.config.loginCommand, message.slice(0, 200));
    }
    return classifyProviderFailure("codex", this.config.loginCommand, err);
  }

  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new ProviderError("codex", "app-server is not running"));
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  private respond(id: number | string, result: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private ensureOpen(): Promise<void> {
    this.opening ??= this.open();
    return this.opening;
  }

  private async open(): Promise<void> {
    const { executable, env, options } = this.config;
    const child = spawn(executable, ["app-server"], {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", (err) => this.fail(this.classify(err)));
    child.on("exit", (code) => {
      if (this.closed) return;
      this.fail(this.classify(new Error(`codex app-server exited with code ${code}${stderr ? `: ${stderr.trim().slice(-400)}` : ""}`)));
    });
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      this.dispatch(msg);
    });

    await this.request("initialize", {
      clientInfo: { name: this.config.options.appName ?? "yagami", title: this.config.options.appName ?? "yagami", version: VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized", {});

    const native = (options.native ?? {}) as CodexNative;
    const overrides = {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(native.approvalPolicy ? { approvalPolicy: native.approvalPolicy } : {}),
      ...(native.sandbox ? { sandbox: native.sandbox } : {}),
      ...(native.config ? { config: native.config } : {}),
      ...(options.systemPrompt ? { developerInstructions: options.systemPrompt } : {}),
    };
    if (options.resume && (options.fork || options.forkAt)) {
      const forked = await this.request("thread/fork", {
        threadId: options.resume,
        ...(options.forkAt ? { lastTurnId: options.forkAt } : {}),
        ...overrides,
      });
      this.threadId = (forked["thread"] as { id?: string } | undefined)?.id;
      if (!this.threadId) throw new ProviderError("codex", "thread/fork returned no thread id");
      return;
    }
    if (options.resume) {
      try {
        const resumed = await this.request("thread/resume", { threadId: options.resume, ...overrides });
        this.threadId = (resumed["thread"] as { id?: string } | undefined)?.id ?? options.resume;
        return;
      } catch {
        // the thread is gone (deleted, another machine) — start fresh below
      }
    }
    const started = await this.request("thread/start", overrides);
    this.threadId = (started["thread"] as { id?: string } | undefined)?.id;
    if (!this.threadId) throw new ProviderError("codex", "thread/start returned no thread id");
  }

  // ── inbound traffic ────────────────────────────────────────────────

  private dispatch(msg: RpcMessage): void {
    // responses to our requests
    if (msg.method === undefined && msg.id !== undefined) {
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);
      if (msg.error) pending.reject(this.classify(new Error(msg.error.message ?? "codex error")));
      else pending.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    // server-initiated requests (approvals and friends) carry an id
    if (msg.id !== undefined) {
      void this.handleServerRequest(msg.method, msg.id, msg.params ?? {});
      return;
    }
    this.handleNotification(msg.method, msg.params ?? {});
  }

  private push(event: AgentEvent): void {
    this.queue?.push(event);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (params["threadId"] !== undefined && params["threadId"] !== this.threadId) return;
    switch (method) {
      case "item/agentMessage/delta": {
        const itemId = params["itemId"] as string;
        const delta = params["delta"] as string;
        this.emitted.set(itemId, (this.emitted.get(itemId) ?? 0) + delta.length);
        this.push({ type: "text", text: delta });
        break;
      }
      case "item/started":
      case "item/completed": {
        this.handleItem(params["item"] as Record<string, unknown>, method === "item/completed");
        break;
      }
      case "thread/tokenUsage/updated": {
        const usage = params["tokenUsage"] as { last?: Record<string, number> } | undefined;
        const last = usage?.last;
        if (last) {
          this.lastUsage = {
            input_tokens: last["inputTokens"] ?? 0,
            output_tokens: last["outputTokens"] ?? 0,
            cache_read_input_tokens: last["cachedInputTokens"] ?? 0,
            cache_creation_input_tokens: last["cacheWriteInputTokens"] ?? 0,
          };
        }
        break;
      }
      case "turn/plan/updated": {
        const steps = Array.isArray(params["plan"]) ? params["plan"] : [];
        this.push({
          type: "plan",
          plan: {
            ...(typeof params["explanation"] === "string" ? { explanation: params["explanation"] } : {}),
            entries: steps.flatMap((value) => {
              const step = value as Record<string, unknown>;
              if (typeof step["step"] !== "string") return [];
              return [{
                content: step["step"],
                status: codexPlanStatus(step["status"]),
              }];
            }),
          },
        });
        break;
      }
      case "turn/completed": {
        const turn = params["turn"] as { status?: string; error?: { message?: string } | null };
        const queue = this.queue;
        this.queue = null;
        this.currentTurnId = undefined;
        if (!queue) break;
        if (turn.status === "failed") {
          queue.fail(this.classify(new Error(turn.error?.message ?? "turn failed")));
        } else {
          queue.push({
            type: "done",
            ...(this.lastUsage ? { usage: this.lastUsage } : {}),
            stopReason: turn.status === "interrupted" ? "interrupted" : "end_turn",
          });
          queue.end();
        }
        break;
      }
      case "error": {
        // non-fatal server chatter; the turn's fate rides turn/completed
        this.push({ type: "raw", provider: "codex", payload: { method, params } });
        break;
      }
      default:
        break;
    }
  }

  /** Normalize thread items into tool_call / thinking events. */
  private handleItem(item: Record<string, unknown> | undefined, completed: boolean): void {
    if (!item) return;
    const id = String(item["id"] ?? "");
    switch (item["type"]) {
      case "agentMessage": {
        if (!completed) break;
        // fill in whatever the deltas didn't cover (non-streaming paths)
        const text = String(item["text"] ?? "");
        const seen = this.emitted.get(id) ?? 0;
        if (text.length > seen) this.push({ type: "text", text: text.slice(seen) });
        this.emitted.delete(id);
        break;
      }
      case "reasoning": {
        if (!completed) break;
        const summary = (item["summary"] as string[] | undefined)?.join("\n") ?? "";
        if (summary) this.push({ type: "thinking", text: summary });
        break;
      }
      case "commandExecution": {
        const failed = item["status"] === "failed" || item["status"] === "declined";
        this.push({
          type: "tool_call",
          id,
          name: "shell",
          status: completed ? (failed ? "failed" : "completed") : "started",
          title: String(item["command"] ?? "command"),
          kind: "execute",
          input: { command: item["command"], cwd: item["cwd"] },
          ...(completed ? { output: { output: item["aggregatedOutput"], exitCode: item["exitCode"] } } : {}),
        });
        break;
      }
      case "fileChange": {
        const changes = (item["changes"] as Array<{ path?: string }> | undefined) ?? [];
        const failed = item["status"] === "failed" || item["status"] === "declined";
        this.push({
          type: "tool_call",
          id,
          name: "apply_patch",
          status: completed ? (failed ? "failed" : "completed") : "started",
          title: changes.map((c) => c.path).filter(Boolean).join(", ") || "file changes",
          kind: "edit",
          input: { changes },
        });
        break;
      }
      case "mcpToolCall": {
        this.push({
          type: "tool_call",
          id,
          name: `${String(item["server"] ?? "mcp")}.${String(item["tool"] ?? "tool")}`,
          status: completed ? (item["status"] === "failed" ? "failed" : "completed") : "started",
          kind: "other",
          input: item["arguments"],
        });
        break;
      }
      case "webSearch": {
        this.push({
          type: "tool_call",
          id,
          name: "web_search",
          status: completed ? "completed" : "started",
          kind: "fetch",
          input: { query: item["query"] },
        });
        break;
      }
      case "dynamicToolCall": {
        const failed = item["status"] === "failed" || item["success"] === false;
        const namespace = typeof item["namespace"] === "string" ? `${item["namespace"]}.` : "";
        this.push({
          type: "tool_call",
          id,
          name: `${namespace}${String(item["tool"] ?? "tool")}`,
          status: completed ? (failed ? "failed" : "completed") : "started",
          kind: "other",
          input: item["arguments"],
          ...(completed ? { output: item["contentItems"] } : {}),
        });
        break;
      }
      case "collabAgentToolCall": {
        const status = item["status"];
        const failed = status === "failed" || status === "interrupted";
        const tool = collabToolName(item["tool"]);
        this.push({
          type: "tool_call",
          id,
          name: tool,
          status: completed ? (failed ? "failed" : "completed") : "started",
          title: typeof item["prompt"] === "string" && item["prompt"] ? item["prompt"] : tool,
          kind: "other",
          input: {
            prompt: item["prompt"],
            model: item["model"],
            effort: item["reasoningEffort"],
            receiverThreadIds: item["receiverThreadIds"],
          },
          ...(completed ? { output: item["agentsStates"] } : {}),
        });
        break;
      }
      case "imageView": {
        this.push({
          type: "tool_call",
          id,
          name: "read_file",
          status: completed ? "completed" : "started",
          title: String(item["path"] ?? "image"),
          kind: "read",
          input: { path: item["path"] },
        });
        break;
      }
      case "userMessage":
      case "plan":
        break;
      default:
        this.push({ type: "raw", provider: "codex", payload: item });
        break;
    }
  }

  // ── approvals: forwarded to the host, answered like the TUI would ──

  private async decide(request: SessionPermissionRequest): Promise<SessionPermissionDecision> {
    try {
      const decision = await this.config.options.permissions.decide(request);
      this.push({ type: "permission", request, decision });
      return decision;
    } catch {
      return "deny";
    }
  }

  private async handleServerRequest(method: string, id: number | string, params: Record<string, unknown>): Promise<void> {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const decision = await this.decide({
          provider: "codex",
          ...(this.threadId ? { sessionId: this.threadId } : {}),
          tool: "shell",
          kind: "execute",
          title: String(params["command"] ?? "command"),
          input: { command: params["command"], cwd: params["cwd"], reason: params["reason"] },
          raw: params,
        });
        this.respond(id, {
          decision: decision === "allow" ? "accept" : decision === "allow_always" ? "acceptForSession" : "decline",
        });
        break;
      }
      case "item/fileChange/requestApproval": {
        const decision = await this.decide({
          provider: "codex",
          ...(this.threadId ? { sessionId: this.threadId } : {}),
          tool: "apply_patch",
          kind: "edit",
          title: String(params["reason"] ?? "apply file changes"),
          input: { reason: params["reason"], grantRoot: params["grantRoot"] },
          raw: params,
        });
        this.respond(id, {
          decision: decision === "allow" ? "accept" : decision === "allow_always" ? "acceptForSession" : "decline",
        });
        break;
      }
      case "item/permissions/requestApproval": {
        const requested = params["permissions"] as Record<string, unknown> | undefined;
        const decision = await this.decide({
          provider: "codex",
          ...(this.threadId ? { sessionId: this.threadId } : {}),
          tool: "permissions",
          kind: "other",
          title: String(params["reason"] ?? "extra permissions"),
          input: requested,
          raw: params,
        });
        const granted = decision === "allow" || decision === "allow_always";
        this.respond(id, {
          permissions: granted ? { network: requested?.["network"] ?? undefined, fileSystem: requested?.["fileSystem"] ?? undefined } : {},
          scope: decision === "allow_always" ? "session" : "turn",
        });
        break;
      }
      // legacy approval shapes, still sent by some codepaths
      case "execCommandApproval":
      case "applyPatchApproval": {
        const decision = await this.decide({
          provider: "codex",
          ...(this.threadId ? { sessionId: this.threadId } : {}),
          tool: method === "execCommandApproval" ? "shell" : "apply_patch",
          kind: method === "execCommandApproval" ? "execute" : "edit",
          title: String(params["command"] ?? params["reason"] ?? "approval"),
          input: params,
          raw: params,
        });
        this.respond(id, {
          decision:
            decision === "allow"
              ? "approved"
              : decision === "allow_always"
                ? "approved_for_session"
                : { denied: { rejection: "denied by the user" } },
        });
        break;
      }
      case "item/tool/requestUserInput": {
        const response = await this.input(codexQuestionRequest(this.threadId, params));
        const values = response.action === "accept" ? response.values ?? {} : {};
        this.respond(id, {
          answers: Object.fromEntries(
            Object.entries(values).map(([key, value]) => [
              key,
              { answers: (Array.isArray(value) ? value : [value]).map(String) },
            ]),
          ),
        });
        break;
      }
      case "mcpServer/elicitation/request": {
        const response = await this.input(elicitationRequest("codex", this.threadId, params));
        this.respond(id, { ...elicitationResponse(response), _meta: null });
        break;
      }
      case "currentTime/read": {
        this.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        break;
      }
      default: {
        // unknown server request — decline rather than hang the turn
        this.child?.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported request: ${method}` } })}\n`,
        );
        break;
      }
    }
  }

  private async input(request: SessionInputRequest): Promise<SessionInputResponse> {
    const handler = this.config.options.input;
    if (!handler) return declineInput();
    try {
      return await handler.respond(request);
    } catch {
      return { action: "cancel" };
    }
  }

  // ── the ProviderSession surface ────────────────────────────────────

  async *send(input: string | ContentBlockParam[]): AsyncGenerator<AgentEvent, void, undefined> {
    if (this.closed) throw new ProviderError("codex", "session is closed");
    if (this.queue) throw new ProviderError("codex", "a turn is already running");
    await this.ensureOpen();

    const blocks = typeof input === "string" ? [{ type: "text", text: input } as ContentBlockParam] : input;
    const { paths, cleanup } = writeTempImages(blocks);
    const items: Array<Record<string, unknown>> = [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        items.push({ type: "text", text: block.text, text_elements: [] });
      }
    }
    for (const p of paths) items.push({ type: "localImage", path: p });
    if (items.length === 0) items.push({ type: "text", text: "", text_elements: [] });

    const queue = new AsyncQueue<AgentEvent>();
    this.queue = queue;
    this.lastUsage = undefined;
    try {
      const result = await this.request("turn/start", {
        threadId: this.threadId,
        input: items,
        ...(this.config.options.effort ? { effort: this.config.options.effort } : {}),
      });
      this.currentTurnId = (result["turn"] as { id?: string } | undefined)?.id;
      yield { type: "session", sessionId: this.threadId! };
      if (this.currentTurnId) yield { type: "turn", id: this.currentTurnId };
      for await (const event of queue) yield event;
    } finally {
      cleanup();
      if (this.queue === queue) this.queue = null;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.currentTurnId) return;
    await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.currentTurnId }).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new ProviderError("codex", "session closed"));
    this.child?.kill("SIGTERM");
    this.child = undefined;
  }
}

function collabToolName(value: unknown): string {
  const names: Record<string, string> = {
    spawnAgent: "spawn_agent",
    sendInput: "send_input",
    resumeAgent: "resume_agent",
    closeAgent: "close_agent",
    sendMessage: "send_message",
    followupTask: "followup_task",
    interruptAgent: "interrupt_agent",
    listAgents: "list_agents",
  };
  return names[String(value)] ?? String(value ?? "agent");
}

function codexPlanStatus(value: unknown): SessionPlanStatus {
  return value === "completed" ? "completed" : value === "inProgress" || value === "in_progress" ? "in_progress" : "pending";
}

function codexQuestionRequest(sessionId: string | undefined, raw: Record<string, unknown>): SessionInputRequest {
  const questions = Array.isArray(raw["questions"]) ? raw["questions"] : [];
  const fields: SessionInputField[] = questions.flatMap((value) => {
    const question = value as Record<string, unknown>;
    if (typeof question["id"] !== "string" || typeof question["question"] !== "string") return [];
    const choices = Array.isArray(question["options"])
      ? question["options"].flatMap((option) => {
          const item = option as Record<string, unknown>;
          if (typeof item["label"] !== "string") return [];
          return [{
            value: item["label"],
            label: item["label"],
            ...(typeof item["description"] === "string" ? { description: item["description"] } : {}),
          }];
        })
      : [];
    return [{
      id: question["id"],
      label: question["question"],
      ...(typeof question["header"] === "string" ? { description: question["header"] } : {}),
      type: choices.length > 0 ? "select" : "string",
      required: true,
      secret: question["isSecret"] === true,
      allowOther: question["isOther"] === true,
      ...(choices.length > 0 ? { options: choices } : {}),
    }];
  });
  return {
    provider: "codex",
    ...(sessionId ? { sessionId } : {}),
    kind: "questions",
    message: fields.length === 1 ? fields[0]!.label : "Input requested",
    fields,
    blocking: raw["isBlocking"] !== false,
    raw,
  };
}
