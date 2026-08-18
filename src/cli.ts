#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { Command } from "commander";
import { YagamiEngine } from "./core/engine.js";
import { resolveClaudeExecutable } from "./core/executable.js";
import { startYagami } from "./server.js";
import {
  configFilePath,
  generateApiKey,
  loadConfig,
  loadFileConfig,
  maskKey,
  saveConfig,
  sessionCachePath,
} from "./server/config.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("yagami")
  .description("Anthropic-compatible API served by your signed-in Claude Code CLI")
  .version(VERSION);

program
  .command("start", { isDefault: true })
  .description("start the yagami server")
  .option("-p, --port <port>", "port to listen on")
  .option("-H, --host <host>", "host to bind (default 127.0.0.1)")
  .option("--claude <path>", "path to the claude executable")
  .option("--cors", "enable permissive CORS (for browser clients)")
  .action(async (opts: { port?: string; host?: string; claude?: string; cors?: boolean }) => {
    // First run: generate a key automatically so the endpoint is never open.
    const fileConfig = loadFileConfig();
    let freshKey: string | undefined;
    if (fileConfig.apiKeys.length === 0 && !process.env["YAGAMI_API_KEY"]) {
      freshKey = generateApiKey();
      fileConfig.apiKeys.push(freshKey);
      saveConfig(fileConfig);
    }

    try {
      const running = await startYagami({
        port: opts.port !== undefined ? Number(opts.port) : undefined,
        host: opts.host,
        claudePath: opts.claude,
        cors: opts.cors,
      });

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
