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
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { ContentBlock as AcpContentBlock } from "@agentclientprotocol/sdk";
import { resolveExecutable } from "../executable.js";
import { classifyProviderFailure, looksLikeAuthFailure, AuthRequiredError, ProviderError } from "../errors.js";
import type { EngineModel } from "../models.js";
import type { Provider, ProviderCapabilities, TurnEvent, TurnRequest } from "../provider.js";
import type { ContentBlockParam, Usage } from "../types.js";
import { AsyncQueue } from "./queue.js";
import { VERSION } from "../../version.js";

export interface AcpHandlers {
  onUpdate?: (n: SessionNotification) => void;
  onPermission?: (p: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
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
export class AcpProvider implements Provider {
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
  };

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
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
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
      return flattenSelectOptions(option).map((o) => ({
        id: o.value,
        display_name: o.name,
        ...(o.description ? { description: o.description } : {}),
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
