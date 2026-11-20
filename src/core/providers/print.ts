import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveExecutable } from "../executable.js";
import { classifyProviderFailure, ProviderError } from "../errors.js";
import { debug } from "../log.js";
import type { EngineModel } from "../models.js";
import type { Provider, ProviderCapabilities, TurnEvent, TurnRequest } from "../provider.js";
import { killTree } from "./process.js";
import { AsyncQueue } from "./queue.js";

export interface PrintProviderOptions {
  id: string;
  label: string;
  /** Executable name or path, resolved like any other CLI. */
  command: string;
  /**
   * Arguments of the CLI's non-interactive mode (`["run", "-q"]`,
   * `["-p", "{prompt}"]`). `{prompt}` is replaced by the prompt; with no
   * placeholder the prompt is written to the CLI's stdin instead, which is
   * the safer of the two: an argument that starts with `-` reads as a flag,
   * and a long one can exceed the kernel's argument limit.
   */
  args?: string[];
  /** Arguments that select a model, `{model}` replaced (`["--model", "{model}"]`). Omitted: the model can't be chosen. */
  modelArgs?: string[];
  /** Model ids to list. A print-mode CLI has no way to be asked. */
  models?: string[];
  /** Explicit executable path override (wins over `command`). */
  path?: string;
  env?: Record<string, string>;
  workDir?: string;
  loginCommand?: string;
  installHint?: string;
}

// CSI and OSC sequences: colour, cursor movement, window titles
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * A CLI with nothing but a print mode: run it with the prompt, and what it
 * writes to stdout is the reply. No sessions, no token counts, no model
 * list — the least a harness can offer, for the ones that speak neither ACP
 * nor a protocol of their own.
 *
 * There is also no permission channel: yagami cannot refuse such a CLI a
 * tool the way it refuses an ACP agent's requests. Whether a turn can edit
 * files or run commands is whatever the CLI's print mode does unasked, so
 * pass the flags that keep it read-only.
 */
export class PrintProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly executable: string;
  readonly loginCommand: string;
  readonly capabilities: ProviderCapabilities = {
    resume: false,
    fork: false,
    images: false,
    documents: false,
    systemPrompt: false,
    thinking: false,
    effort: false,
    streaming: "chunks",
    serverTools: false,
    mcpServers: false,
  };

  private readonly args: string[];
  private readonly modelArgs: string[] | undefined;
  private readonly models: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly workDir: string;

  constructor(options: PrintProviderOptions) {
    this.id = options.id;
    this.label = options.label;
    this.loginCommand = options.loginCommand ?? `${options.command} (sign in per its docs)`;
    this.executable = resolveExecutable(options.id, options.command, options.installHint ?? `Install \`${options.command}\` and sign in.`, {
      ...(options.path ? { explicit: options.path } : {}),
    });
    this.args = options.args ?? [];
    this.modelArgs = options.modelArgs;
    this.models = options.models ?? [];
    this.env = { ...process.env, ...options.env };
    this.workDir = options.workDir ?? path.join(os.tmpdir(), "yagami-workspace");
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  /** The argument list for a turn, and whether the prompt still has to go to stdin (exported for tests). */
  buildArgs(req: TurnRequest): { args: string[]; stdin: boolean } {
    const inArgs = this.args.some((a) => a.includes("{prompt}"));
    const args = this.args.map((a) => a.replaceAll("{prompt}", req.prompt));
    if (req.model) {
      if (!this.modelArgs) throw new ProviderError(this.id, `cannot select model "${req.model}": this CLI's print mode takes no model (omit the model)`);
      // after the mode's own arguments: a subcommand's flags follow the subcommand (`crush run -m …`)
      args.push(...this.modelArgs.map((a) => a.replaceAll("{model}", req.model!)));
    }
    return { args, stdin: !inArgs };
  }

  async *run(req: TurnRequest): AsyncGenerator<TurnEvent, void, undefined> {
    const { args, stdin } = this.buildArgs(req);
    const queue = new AsyncQueue<TurnEvent>();
    const child = spawn(this.executable, args, {
      cwd: this.workDir,
      // a CLI that finds no terminal has no reason to colour or page its output
      env: { ...this.env, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let sawText = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
    });
    child.stdin.on("error", (err) => debug(this.id, `${this.label} closed its stdin early`, err));
    // the newline a CLI ends its output with is not part of the reply: trailing
    // whitespace is held back until more text shows it was not the end
    let held = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const all = held + chunk.toString().replace(ANSI, "");
      const text = all.trimEnd();
      held = all.slice(text.length);
      if (!text) return;
      sawText = true;
      queue.push({ type: "text", text });
    });
    const onAbort = () => {
      killTree(child);
      queue.end();
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    queue.onReturn = () => killTree(child);
    child.on("error", (err) => queue.fail(classifyProviderFailure(this.id, this.loginCommand, err)));
    child.on("close", (code) => {
      queue.onReturn = undefined;
      if (req.signal?.aborted) return queue.end();
      if (code !== 0 || !sawText) {
        const said = stderr.replace(ANSI, "").trim().split("\n").slice(-3).join(" | ");
        const why = code !== 0 ? `exited with code ${code}` : "printed nothing";
        return queue.fail(classifyProviderFailure(this.id, this.loginCommand, new Error(`${this.label} ${why}${said ? `: ${said}` : ""}`)));
      }
      // a print mode reports no token counts
      queue.push({ type: "done", usage: { input_tokens: 0, output_tokens: 0 }, stopReason: "end_turn" });
      queue.end();
    });
    child.stdin.end(stdin ? req.prompt : "");
    try {
      for await (const ev of queue) yield ev;
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  async listModels(): Promise<EngineModel[]> {
    return this.models.map((id) => ({ id, display_name: id }));
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
