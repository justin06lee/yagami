import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, loadFileConfig, saveConfig } from "../src/server/config.js";

describe("loadFileConfig", () => {
  const savedDir = process.env["YAGAMI_CONFIG_DIR"];
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-config-"));
    process.env["YAGAMI_CONFIG_DIR"] = dir;
  });
  afterEach(() => {
    if (savedDir === undefined) delete process.env["YAGAMI_CONFIG_DIR"];
    else process.env["YAGAMI_CONFIG_DIR"] = savedDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    expect(loadFileConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("round-trips through saveConfig", () => {
    saveConfig({ ...DEFAULT_CONFIG, port: 9999, apiKeys: ["ygm_a"], providers: { codex: { sandbox: "read-only" } } });
    const cfg = loadFileConfig();
    expect(cfg.port).toBe(9999);
    expect(cfg.apiKeys).toEqual(["ygm_a"]);
    expect(cfg.providers).toEqual({ codex: { sandbox: "read-only" } });
  });

  it("refuses a corrupt config file instead of silently using defaults", () => {
    // Defaults here would mean the next `start` saves defaults + a fresh key
    // over the user's providers, so this must be loud.
    fs.writeFileSync(path.join(dir, "config.json"), '{"port": 9999,');
    expect(() => loadFileConfig()).toThrowError(/not valid JSON/);
    fs.writeFileSync(path.join(dir, "config.json"), "[1, 2]");
    expect(() => loadFileConfig()).toThrowError(/JSON object/);
  });

  it("keeps only string api keys", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ apiKeys: ["ygm_a", 5, null] }));
    expect(loadFileConfig().apiKeys).toEqual(["ygm_a"]);
  });

  it("layers env overrides on top without persisting them", () => {
    const saved = { ...process.env };
    process.env["YAGAMI_PORT"] = "1234";
    process.env["YAGAMI_API_KEY"] = "ygm_env";
    try {
      const cfg = loadConfig();
      expect(cfg.port).toBe(1234);
      expect(cfg.apiKeys).toEqual(["ygm_env"]);
      expect(loadFileConfig().apiKeys).toEqual([]);
    } finally {
      delete process.env["YAGAMI_PORT"];
      delete process.env["YAGAMI_API_KEY"];
      if (saved["YAGAMI_PORT"] !== undefined) process.env["YAGAMI_PORT"] = saved["YAGAMI_PORT"];
      if (saved["YAGAMI_API_KEY"] !== undefined) process.env["YAGAMI_API_KEY"] = saved["YAGAMI_API_KEY"];
    }
  });
});
