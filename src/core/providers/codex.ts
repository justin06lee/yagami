import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { resolveExecutable } from "../executable.js";
import { classifyProviderFailure, ProviderError } from "../errors.js";
import type { EngineModel } from "../models.js";
import type {
  Provider,
  ProviderCapabilities,
  ProviderSession,
  ProviderSessionOptions,
  SessionProvider,
  TurnEvent,
  TurnRequest,
} from "../provider.js";
import type { ContentBlockParam, Usage } from "../types.js";
import { CodexAgentSession } from "./codexSession.js";
import { spawnJsonl } from "./jsonl.js";
import { VERSION } from "../../version.js";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexProviderOptions {
  /** Path to the `codex` binary. Auto-resolved when omitted. */
  path?: string;
  /** Working directory for completion turns. */
  workDir?: string;
  /** Sandbox for completion turns (default read-only). */
  sandbox?: CodexSandboxMode;
  env?: Record<string, string>;
}

const INSTALL_HINT = "Install Codex CLI (npm i -g @openai/codex or brew install codex) and run `codex login`.";

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  message?: string;
}

/** OpenAI Codex CLI via `codex exec --json`, signed in with the user's ChatGPT account. */
export class CodexProvider implements SessionProvider {
  readonly id = "codex";
  readonly label = "Codex CLI";
  readonly executable: string;
  readonly loginCommand = "codex login";
  readonly capabilities: ProviderCapabilities = {
    resume: true,
    fork: false,
    images: true,
    documents: false,
    systemPrompt: false,
    thinking: false,
    effort: true,
    streaming: "chunks",
  };

  private readonly workDir: string;
  private readonly sandbox: CodexSandboxMode;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: CodexProviderOptions = {}) {
    this.executable = resolveExecutable("codex", "codex", INSTALL_HINT, {
      ...(options.path ?? process.env["YAGAMI_CODEX_PATH"]
        ? { explicit: options.path ?? process.env["YAGAMI_CODEX_PATH"] }
        : {}),
    });
    this.workDir = options.workDir ?? path.join(os.tmpdir(), "yagami-workspace");
    this.sandbox = options.sandbox ?? "read-only";
    this.env = { ...process.env, ...options.env };
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  /** Build the `codex exec` argument list for a turn (exported for tests). */
  buildArgs(req: TurnRequest, imagePaths: string[]): string[] {
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", this.workDir, "-s", this.sandbox, "--color", "never"];
    if (req.model) args.push("-m", req.model);
    if (req.effort) args.push("-c", `model_reasoning_effort="${req.effort}"`);
    for (const p of imagePaths) args.push("-i", p);
    if (req.resume) args.push("resume", req.resume);
    args.push(req.prompt);
    return args;
  }

  async *run(req: TurnRequest): AsyncGenerator<TurnEvent, void, undefined> {
    const { paths: imagePaths, cleanup } = writeTempImages(req.media ?? []);
    const emitted = new Map<string, number>();
    let done = false;
    try {
      for await (const raw of spawnJsonl({
        command: this.executable,
        args: this.buildArgs(req, imagePaths),
        cwd: this.workDir,
        env: this.env,
        ...(req.signal ? { signal: req.signal } : {}),
      })) {
        const ev = raw as { type: string; thread_id?: string; item?: CodexItem; usage?: Record<string, number>; error?: { message?: string }; message?: string };
        switch (ev.type) {
          case "thread.started":
            if (ev.thread_id) yield { type: "session", sessionId: ev.thread_id };
            break;
          case "item.started":
          case "item.updated":
          case "item.completed": {
            const item = ev.item;
            if (!item || typeof item.text !== "string") break;
            if (item.type !== "agent_message" && item.type !== "reasoning") break;
            // Items carry their full text so far; emit only what is new.
            const seen = emitted.get(item.id) ?? 0;
            const fresh = item.text.slice(seen);
            emitted.set(item.id, item.text.length);
            if (fresh) yield { type: item.type === "agent_message" ? "text" : "thinking", text: fresh };
            break;
          }
          case "turn.completed":
            done = true;
            yield { type: "done", usage: mapCodexUsage(ev.usage ?? {}), stopReason: "end_turn" };
            break;
          case "turn.failed":
            throw new Error(ev.error?.message ?? "turn failed");
          case "error":
            throw new Error(ev.message ?? "codex error");
          default:
            break;
        }
      }
    } catch (err) {
      throw classifyProviderFailure(this.id, this.loginCommand, err);
    } finally {
      cleanup();
    }
    if (req.signal?.aborted) return;
    if (!done) throw new ProviderError(this.id, "codex exited without completing the turn");
  }

  /**
   * A live, interactive Codex session (`codex app-server` — the TUI's own
   * engine): streamed tool events, the user's config.toml verbatim, and
   * approval requests forwarded to the host's permission handler. The
   * completion-turn `run()` path above stays for API-style callers.
   */
  openSession(options: ProviderSessionOptions): ProviderSession {
    return new CodexAgentSession({
      executable: this.executable,
      env: this.env,
      loginCommand: this.loginCommand,
      options,
    });
  }

  /** Ask the app-server protocol for the model catalog (no tokens spent). */
  listModels(): Promise<EngineModel[]> {
    return new Promise<EngineModel[]>((resolve, reject) => {
      const child = spawn(this.executable, ["app-server"], { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new ProviderError(this.id, "timed out listing models via app-server"))), 15_000);
      timer.unref?.();
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err) => finish(() => reject(classifyProviderFailure(this.id, this.loginCommand, err))));
      child.on("close", () =>
        finish(() => reject(classifyProviderFailure(this.id, this.loginCommand, new Error(stderr.trim() || "app-server exited")))),
      );
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        let msg: { id?: number; result?: { data?: Array<Record<string, unknown>> }; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} })}\n`);
        } else if (msg.id === 2) {
          if (msg.error) {
            finish(() => reject(classifyProviderFailure(this.id, this.loginCommand, new Error(msg.error?.message ?? "model/list failed"))));
            return;
          }
          const models = (msg.result?.data ?? [])
            .filter((m) => m["hidden"] !== true)
            .map((m) => {
              const efforts = Array.isArray(m["supportedReasoningEfforts"])
                ? (m["supportedReasoningEfforts"] as Array<Record<string, unknown>>).flatMap((entry) =>
                    typeof entry["reasoningEffort"] === "string"
                      ? [{
                          id: entry["reasoningEffort"],
                          ...(typeof entry["description"] === "string" ? { description: entry["description"] } : {}),
                        }]
                      : [],
                  )
                : [];
              const tiers = Array.isArray(m["serviceTiers"])
                ? (m["serviceTiers"] as Array<Record<string, unknown>>).flatMap((entry) =>
                    typeof entry["id"] === "string"
                      ? [{
                          id: entry["id"],
                          display_name: typeof entry["name"] === "string" ? entry["name"] : entry["id"],
                          ...(typeof entry["description"] === "string" ? { description: entry["description"] } : {}),
                        }]
                      : [],
                  )
                : [];
              return {
                id: String(m["id"] ?? m["model"]),
                display_name: String(m["displayName"] ?? m["id"] ?? m["model"]),
                ...(typeof m["description"] === "string" ? { description: m["description"] as string } : {}),
                ...(efforts.length > 0 ? { reasoning_efforts: efforts } : {}),
                ...(typeof m["defaultReasoningEffort"] === "string"
                  ? { default_reasoning_effort: m["defaultReasoningEffort"] }
                  : {}),
                ...(Array.isArray(m["inputModalities"])
                  ? { input_modalities: m["inputModalities"].filter((value): value is string => typeof value === "string") }
                  : {}),
                ...(m["supportsPersonality"] === true ? { supports_personality: true } : {}),
                ...(typeof m["multiAgentVersion"] === "string" ? { multi_agent: m["multiAgentVersion"] } : {}),
                ...(tiers.length > 0 ? { service_tiers: tiers } : {}),
                ...(typeof m["defaultServiceTier"] === "string"
                  ? { default_service_tier: m["defaultServiceTier"] }
                  : {}),
                ...(m["isDefault"] === true ? { is_default: true } : {}),
              };
            });
          finish(() => resolve(models));
        }
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "yagami", title: "yagami", version: VERSION } },
        })}\n`,
      );
    });
  }

  async version(): Promise<string | undefined> {
    try {
      const out = spawnSync(this.executable, ["--version"], { encoding: "utf8", timeout: 10_000 });
      return out.stdout?.trim().split("\n")[0] || undefined;
    } catch {
      return undefined;
    }
  }
}

function mapCodexUsage(u: Record<string, number>): Usage {
  return {
    input_tokens: u["input_tokens"] ?? 0,
    output_tokens: u["output_tokens"] ?? 0,
    cache_read_input_tokens: u["cached_input_tokens"] ?? 0,
    cache_creation_input_tokens: u["cache_write_input_tokens"] ?? 0,
  };
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** Codex takes images as files: materialize base64 blocks into a temp dir. */
export function writeTempImages(media: ContentBlockParam[]): { paths: string[]; cleanup: () => void } {
  const images = media.filter((b) => b.type === "image");
  if (images.length === 0) return { paths: [], cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-img-"));
  const paths: string[] = [];
  images.forEach((block, i) => {
    const source = block["source"] as { type?: string; data?: string; media_type?: string } | undefined;
    if (source?.type !== "base64" || typeof source.data !== "string") {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new ProviderError("codex", "only base64 image sources are supported (URL images are not fetched)");
    }
    const file = path.join(dir, `image-${i}${EXT_BY_MIME[source.media_type ?? ""] ?? ".png"}`);
    fs.writeFileSync(file, Buffer.from(source.data, "base64"));
    paths.push(file);
  });
  return { paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
