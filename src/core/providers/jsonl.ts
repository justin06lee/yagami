import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { AsyncQueue } from "./queue.js";

export interface SpawnJsonlOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Text written to the child's stdin before it is closed. */
  stdin?: string;
}

export class ProcessExitError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`process exited with code ${exitCode}${stderr ? `: ${stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`);
    this.name = "ProcessExitError";
  }
}

/**
 * Spawn a CLI that prints one JSON object per stdout line and iterate the
 * parsed objects. Non-JSON lines are skipped. A non-zero exit throws
 * ProcessExitError carrying the stderr tail; aborting the signal kills the
 * child and ends the iteration quietly.
 */
export function spawnJsonl(options: SpawnJsonlOptions): AsyncIterable<unknown> {
  const queue = new AsyncQueue<unknown>();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
  });
  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    try {
      queue.push(JSON.parse(trimmed));
    } catch {
      // partial or non-JSON output — ignore
    }
  });
  const onAbort = () => {
    child.kill("SIGTERM");
    queue.end();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  child.on("error", (err) => queue.fail(err));
  child.on("close", (code) => {
    options.signal?.removeEventListener("abort", onAbort);
    if (options.signal?.aborted) return queue.end();
    if (code !== 0) queue.fail(new ProcessExitError(code, stderr));
    else queue.end();
  });
  if (options.stdin !== undefined) {
    child.stdin?.end(options.stdin);
  }
  return queue;
}
