import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("../../src/core/providers/jsonl.js", () => ({ spawnJsonl: spawnMock }));

import { CodexProvider, writeTempImages } from "../../src/core/providers/codex.js";
import { AuthRequiredError } from "../../src/core/errors.js";
import { collect } from "../helpers/fakeProvider.js";

const FAKE_CODEX = process.execPath;

async function* codexRun(events: unknown[]) {
  for (const e of events) yield e;
}

const SUCCESS = [
  { type: "thread.started", thread_id: "t-1" },
  { type: "turn.started" },
  { type: "item.started", item: { id: "r0", type: "reasoning", text: "thinking" } },
  { type: "item.updated", item: { id: "i0", type: "agent_message", text: "po" } },
  { type: "item.completed", item: { id: "i0", type: "agent_message", text: "pong" } },
  { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 1, output_tokens: 2 } },
];

beforeEach(() => spawnMock.mockReset());

describe("CodexProvider", () => {
  it("maps exec JSONL onto turn events, emitting only new item text", async () => {
    spawnMock.mockImplementation(() => codexRun(SUCCESS));
    const p = new CodexProvider({ path: FAKE_CODEX, workDir: "/tmp/yagami-test-ws" });
    const events = await collect(p.run({ prompt: "ping" }));
    expect(events).toEqual([
      { type: "session", sessionId: "t-1" },
      { type: "thinking", text: "thinking" },
      { type: "text", text: "po" },
      { type: "text", text: "ng" },
      {
        type: "done",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 },
        stopReason: "end_turn",
      },
    ]);
  });

  it("builds exec arguments with flags before the resume subcommand", () => {
    const p = new CodexProvider({ path: FAKE_CODEX, workDir: "/tmp/ws", sandbox: "workspace-write" });
    expect(p.buildArgs({ prompt: "hi", model: "gpt-5", effort: "high", resume: "t-1" }, ["/tmp/a.png"])).toEqual([
      "exec", "--json", "--skip-git-repo-check", "-C", "/tmp/ws", "-s", "workspace-write", "--color", "never",
      "-m", "gpt-5", "-c", 'model_reasoning_effort="high"', "-i", "/tmp/a.png", "resume", "t-1", "hi",
    ]);
    expect(p.buildArgs({ prompt: "hi" }, [])).toEqual([
      "exec", "--json", "--skip-git-repo-check", "-C", "/tmp/ws", "-s", "workspace-write", "--color", "never", "hi",
    ]);
  });

  it("fails with AuthRequiredError when codex reports a login problem", async () => {
    spawnMock.mockImplementation(() => codexRun([{ type: "error", message: "Not logged in. Run `codex login`." }]));
    const p = new CodexProvider({ path: FAKE_CODEX, workDir: "/tmp/ws" });
    await expect(collect(p.run({ prompt: "ping" }))).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("fails when the process ends without completing the turn", async () => {
    spawnMock.mockImplementation(() => codexRun([{ type: "thread.started", thread_id: "t" }]));
    const p = new CodexProvider({ path: FAKE_CODEX, workDir: "/tmp/ws" });
    await expect(collect(p.run({ prompt: "ping" }))).rejects.toThrowError(/without completing/);
  });

  it("materializes base64 images as temp files and cleans them up", () => {
    const { paths, cleanup } = writeTempImages([
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("x").toString("base64") } },
    ]);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/\.png$/);
    cleanup();
  });

  it("refuses URL image sources", () => {
    expect(() => writeTempImages([{ type: "image", source: { type: "url", url: "https://x" } }])).toThrowError(/base64/);
  });
});
