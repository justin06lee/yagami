import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { describe, expect, it } from "vitest";
import { spawnJsonl } from "../../src/core/providers/jsonl.js";
import { killTree } from "../../src/core/providers/process.js";
import { AcpProvider } from "../../src/core/providers/acp.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

describe("killTree", () => {
  it("ends the process and the children it started, even one that ignores SIGTERM", async () => {
    // a launcher that re-spawns itself (as Gemini's does) and shrugs off SIGTERM
    const script = `
      const { spawn } = require("node:child_process");
      const inner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      process.on("SIGTERM", () => {});
      console.log(String(inner.pid));
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    const line = await new Promise<string>((resolve) => {
      readline.createInterface({ input: child.stdout! }).once("line", resolve);
    });
    const inner = Number(line);
    expect(alive(inner)).toBe(true);

    killTree(child, 200);
    expect(await gone(inner)).toBe(true);
    expect(await gone(child.pid!)).toBe(true);
  });

  it("is a no-op for a process that has already exited, and for a second call", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => child.once("exit", r));
    expect(() => {
      killTree(child);
      killTree(child);
    }).not.toThrow();
  });
});

describe("spawnJsonl", () => {
  it("kills the process when the consumer stops iterating early", async () => {
    let pid = 0;
    for await (const line of spawnJsonl({
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000)"],
    })) {
      pid = (line as { pid: number }).pid;
      break;
    }
    expect(pid).toBeGreaterThan(0);
    expect(await gone(pid)).toBe(true);
  });

  it("survives the child closing its stdin before the prompt is written (EPIPE)", async () => {
    // A prompt bigger than the pipe buffer, written to a child that has
    // already closed its end: the write fails with EPIPE, which used to be
    // an unhandled 'error' event — an uncaught exception in the host.
    const lines: unknown[] = [];
    for await (const line of spawnJsonl({
      command: process.execPath,
      args: ["-e", 'process.stdin.destroy(); setTimeout(() => console.log(JSON.stringify({ ok: true })), 150)'],
      stdin: "x".repeat(4 << 20),
    })) {
      lines.push(line);
    }
    expect(lines).toEqual([{ ok: true }]);
  });
});

describe("AcpProvider deadlines", () => {
  it("kills an agent that never finishes the handshake", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-acp-"));
    const pidFile = path.join(dir, "pid");
    const provider = new AcpProvider({
      id: "stuck",
      label: "Stuck",
      command: "node",
      path: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`],
      workDir: dir,
      handshakeTimeoutMs: 400,
    });
    await expect(provider.listModels()).rejects.toThrowError(/handshake/);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(await gone(pid)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("closes the agent when a model probe never gets an answer", async () => {
    let closed = 0;
    const provider = new AcpProvider({
      id: "silent",
      label: "Silent",
      command: "silent-agent",
      probeTimeoutMs: 50,
      connect: async () => ({
        agent: { newSession: () => new Promise(() => {}) } as never,
        init: { protocolVersion: 1 } as never,
        setHandlers: () => {},
        close: () => {
          closed += 1;
        },
      }),
    });
    await expect(provider.listModels()).rejects.toThrowError(/did not answer/);
    expect(closed).toBe(1);
  });

  it("closes the agent when a turn is aborted before its session exists", async () => {
    let closed = 0;
    const controller = new AbortController();
    const provider = new AcpProvider({
      id: "slow",
      label: "Slow",
      command: "slow-agent",
      connect: async () => ({
        agent: { newSession: () => new Promise(() => {}) } as never,
        init: { protocolVersion: 1 } as never,
        setHandlers: () => {},
        close: () => {
          closed += 1;
        },
      }),
    });
    const turn = provider.run({ prompt: "hi", signal: controller.signal });
    const first = turn.next();
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(closed).toBeGreaterThanOrEqual(1);
    void first.catch(() => {});
  });
});
