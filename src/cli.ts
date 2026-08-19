#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Command } from "commander";
import { YagamiEngine } from "./core/engine.js";
import { resolveClaudeExecutable } from "./core/executable.js";
import { startYagami } from "./server.js";
import {
  clearServerState,
  configFilePath,
  generateApiKey,
  isProcessAlive,
  loadConfig,
  loadFileConfig,
  logFilePath,
  maskKey,
  readServerState,
  saveConfig,
  sessionCachePath,
  writeServerState,
} from "./server/config.js";
import { VERSION } from "./version.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const program = new Command();

program
  .name("yagami")
  .description("Anthropic-compatible API served by your signed-in Claude Code CLI")
  .version(VERSION);

interface StartFlags {
  port?: string;
  host?: string;
  claude?: string;
  cors?: boolean;
  daemon?: boolean;
  log?: string;
}

program
  .command("start", { isDefault: true })
  .description("start the yagami server")
  .option("-p, --port <port>", "port to listen on")
  .option("-H, --host <host>", "host to bind (default 127.0.0.1)")
  .option("--claude <path>", "path to the claude executable")
  .option("--cors", "enable permissive CORS (for browser clients)")
  .option("--daemon", "run in the background (managed with `yagami stop`/`yagami status`)")
  .option("--log <file>", "log file for --daemon mode (default ~/.config/yagami/yagami.log)")
  .action(async (opts: StartFlags) => {
    // First run: generate a key automatically so the endpoint is never open.
    const fileConfig = loadFileConfig();
    let freshKey: string | undefined;
    if (fileConfig.apiKeys.length === 0 && !process.env["YAGAMI_API_KEY"]) {
      freshKey = generateApiKey();
      fileConfig.apiKeys.push(freshKey);
      saveConfig(fileConfig);
    }

    if (opts.daemon) {
      await startDaemon(opts, freshKey);
      return;
    }

    try {
      const running = await startYagami({
        port: opts.port !== undefined ? Number(opts.port) : undefined,
        host: opts.host,
        claudePath: opts.claude,
        cors: opts.cors,
      });

      writeServerState({
        pid: process.pid,
        host: running.config.host,
        port: running.config.port,
        url: running.url,
        startedAt: new Date().toISOString(),
        version: VERSION,
        ...(process.env["YAGAMI_LOG_FILE"] ? { log: process.env["YAGAMI_LOG_FILE"] } : {}),
      });
      const shutdown = () => {
        running.sessionCache.persistNow();
        clearServerState(process.pid);
        void running.close().finally(() => process.exit(0));
        // Don't hang on a stuck in-flight response.
        setTimeout(() => process.exit(0), 3000).unref?.();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      const claudeVersion = probeClaudeVersion(running.engine.claudePath);
      console.log(`yagami v${VERSION}`);
      console.log(`  listening   ${running.url}`);
      console.log(`  claude      ${running.engine.claudePath}${claudeVersion ? ` (${claudeVersion})` : ""}`);
      console.log(`  config      ${configFilePath()}`);
      if (freshKey) {
        console.log(`  api key     ${freshKey}`);
        console.log("              (newly generated and saved — copy it now, it is shown in full only once)");
      } else {
        console.log(`  api keys    ${running.config.apiKeys.map(maskKey).join(", ")}`);
      }
      if (!["127.0.0.1", "localhost", "::1"].includes(running.config.host)) {
        console.log(
          `  ⚠ bound to ${running.config.host} — reachable beyond this machine. Only do this on a network you trust.`,
        );
      }
      console.log("\nPoint any Anthropic SDK at it:");
      console.log(`  baseURL: "${running.url}"   apiKey: <your yagami key>`);
    } catch (err) {
      console.error(`yagami: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });

async function startDaemon(opts: StartFlags, freshKey: string | undefined): Promise<void> {
  const existing = readServerState();
  if (existing && isProcessAlive(existing.pid)) {
    console.error(`yagami is already running (pid ${existing.pid}, ${existing.url}) — \`yagami stop\` first`);
    process.exitCode = 1;
    return;
  }
  clearServerState();

  const logPath = opts.log ? path.resolve(opts.log) : logFilePath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, "a");
  const args = [process.argv[1]!, "start"];
  if (opts.port !== undefined) args.push("-p", opts.port);
  if (opts.host !== undefined) args.push("-H", opts.host);
  if (opts.claude !== undefined) args.push("--claude", opts.claude);
  if (opts.cors) args.push("--cors");

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, YAGAMI_LOG_FILE: logPath },
  });
  fs.closeSync(fd);
  let exitCode: number | null | undefined;
  child.on("exit", (code) => {
    exitCode = code;
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && exitCode === undefined) {
    const state = readServerState();
    if (state && state.pid === child.pid) {
      console.log(`yagami v${VERSION} running in the background`);
      console.log(`  pid   ${child.pid}`);
      console.log(`  url   ${state.url}`);
      console.log(`  log   ${logPath}`);
      if (freshKey) {
        console.log(`  key   ${freshKey}`);
        console.log("        (newly generated and saved — copy it now, it is shown in full only once)");
      }
      return;
    }
    await sleep(200);
  }
  console.error(
    exitCode !== undefined
      ? `yagami exited immediately (code ${exitCode}) — see ${logPath}`
      : `yagami did not report ready within 15s — see ${logPath}`,
  );
  process.exitCode = 1;
}

program
  .command("stop")
  .description("stop a running yagami server")
  .action(async () => {
    const state = readServerState();
    if (!state || !isProcessAlive(state.pid)) {
      if (state) clearServerState();
      console.log("yagami is not running");
      return;
    }
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(state.pid)) {
        clearServerState();
        console.log(`stopped yagami (pid ${state.pid})`);
        return;
      }
      await sleep(100);
    }
    console.error(`yagami (pid ${state.pid}) did not exit within 5s`);
    process.exitCode = 1;
  });

program
  .command("status")
  .description("show whether yagami is running, plus request/cost totals")
  .action(async () => {
    const state = readServerState();
    if (!state || !isProcessAlive(state.pid)) {
      if (state) clearServerState();
      console.log("yagami is not running");
      process.exitCode = 1;
      return;
    }
    console.log(`yagami running (pid ${state.pid})`);
    console.log(`  url       ${state.url}`);
    console.log(`  since     ${state.startedAt}`);
    if (state.log) console.log(`  log       ${state.log}`);
    try {
      const res = await fetch(`${state.url}/healthz`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as {
        version?: string;
        claude?: string;
        requests?: number;
        total_cost_usd?: number;
      };
      console.log(`  version   ${body.version ?? "?"}`);
      console.log(`  claude    ${body.claude ?? "?"}`);
      console.log(`  requests  ${body.requests ?? 0}`);
      console.log(`  cost      $${(body.total_cost_usd ?? 0).toFixed(4)} (would-be API cost since start)`);
    } catch {
      console.log(`  healthz   unreachable — process is alive but ${state.url} is not answering`);
    }
  });

program
  .command("keygen")
  .description("generate an API key and add it to the config")
  .action(() => {
    const cfg = loadFileConfig();
    const key = generateApiKey();
    cfg.apiKeys.push(key);
    const file = saveConfig(cfg);
    console.log(key);
    console.error(`saved to ${file} (${cfg.apiKeys.length} key${cfg.apiKeys.length === 1 ? "" : "s"} total)`);
  });

program
  .command("doctor")
  .description("check that yagami can find and use your Claude Code install")
  .option("--live", "send one real (tiny) completion through the engine")
  .action(async (opts: { live?: boolean }) => {
    let failed = false;

    console.log(`node        ${process.version}`);

    let claudePath: string | undefined;
    try {
      claudePath = resolveClaudeExecutable(loadConfig().claudePath);
      const version = probeClaudeVersion(claudePath);
      console.log(`claude      ${claudePath}${version ? ` (${version})` : ""}`);
    } catch (err) {
      failed = true;
      console.log(`claude      ✗ ${err instanceof Error ? err.message : String(err)}`);
    }

    const cfg = loadConfig();
    const hasConfigFile = fs.existsSync(configFilePath());
    console.log(`config      ${configFilePath()}${hasConfigFile ? "" : " (not created yet)"}`);
    console.log(`api keys    ${cfg.apiKeys.length === 0 ? "none — run `yagami keygen`" : cfg.apiKeys.map(maskKey).join(", ")}`);
    console.log(`bind        ${cfg.host}:${cfg.port}`);
    console.log(`sessions    ${sessionCachePath()}${fs.existsSync(sessionCachePath()) ? "" : " (empty)"}`);
    const state = readServerState();
    console.log(
      `server      ${state && isProcessAlive(state.pid) ? `running (pid ${state.pid}, ${state.url})` : "not running"}`,
    );

    if (opts.live && claudePath) {
      console.log("\nlive check: sending one tiny completion…");
      try {
        const engine = new YagamiEngine({ claudePath: cfg.claudePath, defaultModel: cfg.defaultModel });
        const started = Date.now();
        const result = await engine.complete({
          model: cfg.defaultModel ?? "sonnet",
          messages: [{ role: "user", content: "Reply with exactly: pong" }],
          max_tokens: 32,
        });
        const text = result.response.content
          .filter((b) => b.type === "text")
          .map((b) => b["text"])
          .join("");
        console.log(`  reply     ${JSON.stringify(text)}`);
        console.log(`  model     ${result.response.model}`);
        console.log(`  latency   ${((Date.now() - started) / 1000).toFixed(1)}s`);
        if (result.costUsd !== undefined) console.log(`  cost      $${result.costUsd.toFixed(6)}`);
      } catch (err) {
        failed = true;
        console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (failed) process.exitCode = 1;
  });

function probeClaudeVersion(claudePath: string): string | undefined {
  try {
    const out = spawnSync(claudePath, ["--version"], { encoding: "utf8", timeout: 10_000 });
    const line = out.stdout?.trim().split("\n")[0];
    return line || undefined;
  } catch {
    return undefined;
  }
}

await program.parseAsync(process.argv);
