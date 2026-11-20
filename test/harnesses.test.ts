import { describe, expect, it } from "vitest";
import { YagamiEngine } from "../src/core/engine.js";
import { ProviderNotInstalledError } from "../src/core/errors.js";
import { listHarnesses } from "../src/core/harnesses.js";
import { PROVIDER_PRESETS } from "../src/core/providers/registry.js";
import { FakeProvider, FULL_CAPS } from "./helpers/fakeProvider.js";

function engineOf(...providers: FakeProvider[]) {
  return new YagamiEngine({ providers, defaultProvider: providers[0]!.id });
}

describe("listHarnesses", () => {
  it("lists every known harness, installed or not, with what to run for each", async () => {
    const list = await listHarnesses({ providerConfig: {}, status: false });
    expect(list.map((h) => h.id)).toEqual(PROVIDER_PRESETS.map((p) => p.id));
    for (const h of list) {
      expect(h.loginCommand, h.id).not.toBe("");
      expect(h.installHint, h.id).not.toBe("");
      // nothing was asked, so nothing is claimed
      expect(h.signedIn, h.id).toBeUndefined();
      if (!h.installed) expect(h).toMatchObject({ available: false, isDefault: false });
    }
    expect(list.filter((h) => h.isDefault).length).toBeLessThanOrEqual(1);
  });

  it("includes custom entries from config, not installed when their command is missing", async () => {
    const list = await listHarnesses({
      providerConfig: { mine: { kind: "print", command: "definitely-not-a-real-binary-xyz", label: "Mine", installHint: "brew install mine", loginCommand: "mine login" } },
      status: false,
    });
    expect(list.find((h) => h.id === "mine")).toEqual({
      id: "mine",
      label: "Mine",
      kind: "print",
      installed: false,
      available: false,
      loginCommand: "mine login",
      installHint: "brew install mine",
      isDefault: false,
    });
  });
});

describe("engine.harnesses", () => {
  it("reports sign-in state, account and capabilities of each provider it holds", async () => {
    const claude = new FakeProvider("claude", FULL_CAPS, undefined, "Claude Code");
    claude.signIn = { signedIn: true, account: "me@example.com", plan: "max" };
    const kimi = new FakeProvider("kimi", { ...FULL_CAPS, serverTools: false, systemPrompt: false }, undefined, "Kimi Code");
    kimi.signIn = { signedIn: false, loginCommand: "kimi login --device", detail: "kimi: not logged in" };
    const list = await engineOf(claude, kimi).harnesses();

    expect(list.find((h) => h.id === "claude")).toMatchObject({
      label: "Claude Code",
      kind: "claude",
      installed: true,
      signedIn: true,
      available: true,
      account: "me@example.com",
      plan: "max",
      isDefault: true,
      path: "/fake/bin",
      capabilities: { images: true, systemPrompt: true, effort: true, webSearch: true },
    });
    // signed out: not available, and the login command is the one the CLI itself named
    expect(list.find((h) => h.id === "kimi")).toMatchObject({
      installed: true,
      signedIn: false,
      available: false,
      loginCommand: "kimi login --device",
      detail: "kimi: not logged in",
      isDefault: false,
      capabilities: { webSearch: false, systemPrompt: false },
    });
    // the rest of the catalog is still there; what this engine does not hold cannot take a turn
    expect(list.find((h) => h.id === "muse")).toMatchObject({ available: false, loginCommand: "muse login" });
    expect(list.find((h) => h.id === "muse")).not.toHaveProperty("signedIn");
    expect(list).toHaveLength(PROVIDER_PRESETS.length);
  });

  it("stays available when the harness cannot say, and survives a check that throws", async () => {
    const unknown = new FakeProvider("grok");
    const broken = new FakeProvider("opencode");
    broken.signIn = new Error("spawn EACCES");
    const list = await engineOf(unknown, broken).harnesses();
    expect(list.find((h) => h.id === "grok")).toMatchObject({ installed: true, available: true });
    expect(list.find((h) => h.id === "grok")).not.toHaveProperty("signedIn");
    expect(list.find((h) => h.id === "opencode")).toMatchObject({ installed: true, available: true, detail: "spawn EACCES" });
  });

  it("skips the sign-in checks when asked, and lists a hand-picked provider it has no preset for", async () => {
    const mine = new FakeProvider("mine", FULL_CAPS, undefined, "Mine");
    mine.signIn = new Error("must not be asked");
    const list = await engineOf(mine).harnesses({ status: false });
    expect(list.find((h) => h.id === "mine")).toMatchObject({ kind: "custom", label: "Mine", installed: true, available: true, isDefault: true });
    expect(list.find((h) => h.id === "mine")).not.toHaveProperty("detail");
  });
});

describe("engine.harnessModels", () => {
  it("lists one harness's models in its own ids, the default first", async () => {
    const grok = new FakeProvider("grok");
    grok.models = [
      { id: "small", display_name: "Small" },
      { id: "big", display_name: "Big", is_default: true, context_window: 256_000, context_window_source: "reported" },
    ];
    const engine = engineOf(new FakeProvider("claude"), grok);
    expect(await engine.harnessModels("grok")).toEqual([
      { id: "big", display_name: "Big", is_default: true, context_window: 256_000, context_window_source: "reported", provider: "grok" },
      { id: "small", display_name: "Small", provider: "grok" },
    ]);
  });

  it("remembers a list until asked to refresh it", async () => {
    const grok = new FakeProvider("grok");
    const engine = engineOf(grok);
    await engine.harnessModels("grok");
    grok.models = [{ id: "new", display_name: "New" }];
    expect((await engine.harnessModels("grok")).map((m) => m.id)).toEqual(["fake-1"]);
    expect((await engine.harnessModels("grok", { refresh: true })).map((m) => m.id)).toEqual(["new"]);
  });

  it("rejects with the typed failure for a harness that is not there", async () => {
    const err = await engineOf(new FakeProvider("claude")).harnessModels("muse").then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderNotInstalledError);
    expect(err).toMatchObject({ provider: "muse" });
    expect((err as ProviderNotInstalledError).installHint).toMatch(/muse-code/);
  });
});

describe("engine.limits", () => {
  it("passes on what the harness reports, and nothing where it cannot say", async () => {
    const claude = new FakeProvider("claude");
    claude.plan = { plan: "max", windows: [{ window: "seven_day", utilization: 0.05, resetsAt: 1795474800, status: "allowed" }] };
    const engine = engineOf(claude, new FakeProvider("grok"));
    expect(await engine.limits()).toEqual(claude.plan);
    expect(await engine.limits("grok")).toBeUndefined();
    await expect(engine.limits("muse")).rejects.toBeInstanceOf(ProviderNotInstalledError);
  });
});
