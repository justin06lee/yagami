import { describe, expect, it } from "vitest";
import { settingSourcesFor } from "../src/core/parity.js";

describe("settingSourcesFor", () => {
  it("maps parity levels to setting sources", () => {
    expect(settingSourcesFor("terminal")).toEqual(["user", "project", "local"]);
    expect(settingSourcesFor("project")).toEqual(["project", "local"]);
    expect(settingSourcesFor("isolated")).toEqual([]);
  });

  it("returns a fresh array each call", () => {
    const a = settingSourcesFor("terminal");
    a.push("x" as never);
    expect(settingSourcesFor("terminal")).toEqual(["user", "project", "local"]);
  });
});
