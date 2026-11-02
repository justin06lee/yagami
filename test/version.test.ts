import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("release version", () => {
  it("exports the 0.14.0 version matching the package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe("0.14.0");
    expect(pkg.version).toBe(VERSION);
  });
});
