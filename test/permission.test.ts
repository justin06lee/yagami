import { describe, expect, it, vi } from "vitest";
import { PermissionAdapter } from "../src/core/permission.js";

const opts = (over: Partial<{ signal: AbortSignal; suggestions: unknown[] }> = {}) => ({
  signal: over.signal ?? new AbortController().signal,
  ...(over.suggestions ? { suggestions: over.suggestions } : {}),
}) as never;

describe("PermissionAdapter", () => {
  it("denies by default when no handler is set", async () => {
    const a = new PermissionAdapter();
    const r = await a.canUseTool("Bash", { command: "ls" }, opts());
    expect(r.behavior).toBe("deny");
  });

  it("allows by default when configured to", async () => {
    const a = new PermissionAdapter({ fallback: "allow" });
    const r = await a.canUseTool("Bash", { command: "ls" }, opts());
    expect(r).toEqual({ behavior: "allow", updatedInput: {} });
  });

  it("routes to the host handler and passes the decision through", async () => {
    const handler = vi.fn(async () => ({ behavior: "allow" as const, updatedInput: { command: "ls -a" } }));
    const a = new PermissionAdapter();
    a.setHandler(handler);
    const r = await a.canUseTool("Bash", { command: "ls" }, opts({ suggestions: [{ x: 1 }] }));
    expect(r).toEqual({ behavior: "allow", updatedInput: { command: "ls -a" } });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ toolName: "Bash", suggestions: [{ x: 1 }] }));
  });

  it("passes deny messages, interrupt, and updatedPermissions through", async () => {
    const a = new PermissionAdapter();
    a.setHandler(async () => ({ behavior: "deny", message: "nope", interrupt: true }));
    expect(await a.canUseTool("Bash", {}, opts())).toEqual({ behavior: "deny", message: "nope", interrupt: true });
    a.setHandler(async () => ({ behavior: "allow", updatedPermissions: [{ y: 2 }] as never }));
    expect(await a.canUseTool("Bash", { c: 1 }, opts())).toEqual({ behavior: "allow", updatedInput: { c: 1 }, updatedPermissions: [{ y: 2 }] });
  });

  it("auto-allow and auto-deny skip the handler", async () => {
    const handler = vi.fn();
    const a = new PermissionAdapter({ autoAllow: ["Read"], autoDeny: ["Bash"] });
    a.setHandler(handler as never);
    expect((await a.canUseTool("Read", { p: 1 }, opts())).behavior).toBe("allow");
    expect((await a.canUseTool("Bash", {}, opts())).behavior).toBe("deny");
    expect(handler).not.toHaveBeenCalled();
    a.allowTool("Bash");
    expect((await a.canUseTool("Bash", {}, opts())).behavior).toBe("allow");
  });

  it("falls back when the handler throws or the request is aborted", async () => {
    const a = new PermissionAdapter();
    a.setHandler(async () => {
      throw new Error("boom");
    });
    expect((await a.canUseTool("Bash", {}, opts())).behavior).toBe("deny");
    const aborted = AbortSignal.abort();
    a.setHandler(async () => ({ behavior: "allow" }));
    expect((await a.canUseTool("Bash", {}, opts({ signal: aborted }))).behavior).toBe("deny");
  });
});
