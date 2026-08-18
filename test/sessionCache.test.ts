import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionCache } from "../src/core/sessionCache.js";

describe("SessionCache", () => {
  it("stores and retrieves", () => {
    const cache = new SessionCache();
    cache.set("a", "s1");
    expect(cache.get("a")).toBe("s1");
    expect(cache.get("missing")).toBeUndefined();
  });

  it("evicts least-recently-used entries beyond maxEntries", () => {
    const cache = new SessionCache({ maxEntries: 2 });
    cache.set("a", "s1");
    cache.set("b", "s2");
    cache.get("a"); // touch a so b is oldest
    cache.set("c", "s3");
    expect(cache.get("a")).toBe("s1");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("s3");
  });

  describe("persistence", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-test-"));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("round-trips through disk", () => {
      const file = path.join(dir, "nested", "sessions.json");
      const cache = new SessionCache({ persistPath: file });
      cache.set("a", "s1");
      cache.set("b", "s2");
      cache.persistNow();

      const reloaded = new SessionCache({ persistPath: file });
      expect(reloaded.get("a")).toBe("s1");
      expect(reloaded.get("b")).toBe("s2");
      expect(reloaded.size).toBe(2);
    });

    it("ignores corrupt cache files", () => {
      const file = path.join(dir, "sessions.json");
      fs.writeFileSync(file, "not json{{{");
      const cache = new SessionCache({ persistPath: file });
      expect(cache.size).toBe(0);
    });
  });
});
