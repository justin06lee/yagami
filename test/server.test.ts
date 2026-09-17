import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startYagami, type RunningServer } from "../src/server.js";
import { FakeProvider } from "./helpers/fakeProvider.js";

const KEY = "ygm_server_test";
const savedDir = process.env["YAGAMI_CONFIG_DIR"];
let dir: string;

beforeAll(() => {
  // never the developer's real config or session cache
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-server-"));
  process.env["YAGAMI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (savedDir === undefined) delete process.env["YAGAMI_CONFIG_DIR"];
  else process.env["YAGAMI_CONFIG_DIR"] = savedDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(overrides: Parameters<typeof startYagami>[0] = {}): Promise<RunningServer> {
  return startYagami({
    host: "127.0.0.1",
    port: 0,
    apiKeys: [KEY],
    log: null,
    providerInstances: [new FakeProvider("fake")],
    ...overrides,
  });
}

describe("startYagami", () => {
  it("refuses to start without an API key", async () => {
    await expect(start({ apiKeys: [] })).rejects.toThrowError(/no API keys/);
  });

  it("serves over real HTTP with explicit providers and gates /healthz details", async () => {
    const running = await start();
    try {
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(running.config.port).toBeGreaterThan(0);
      const open = (await (await fetch(`${running.url}/healthz`)).json()) as Record<string, unknown>;
      expect(open).toEqual({ ok: true, service: "yagami", version: expect.any(String) });
      const keyed = (await (await fetch(`${running.url}/healthz`, { headers: { "x-api-key": KEY } })).json()) as Record<string, unknown>;
      expect(keyed["provider"]).toBe("fake");
      expect(keyed["executable"]).toBe("/fake/bin");

      const res = await fetch(`${running.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify({ messages: [{ role: "user", content: "ping" }] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-yagami-provider")).toBe("fake");
    } finally {
      await running.close();
    }
  });

  it("rejects instead of crashing when the port is taken", async () => {
    const first = await start();
    try {
      await expect(start({ port: first.config.port })).rejects.toThrowError(/cannot listen on 127\.0\.0\.1:\d+: .*EADDRINUSE/);
    } finally {
      await first.close();
    }
  });
});
