#!/usr/bin/env node
/**
 * A scripted `codex app-server` for CodexAgentSession tests: JSON-RPC over
 * stdio, thread/turn API. One turn: two message deltas, a command execution
 * gated on an approval round-trip (the decision is echoed into the command
 * output so tests can assert it), token usage, and a completed message whose
 * full text exceeds the deltas (exercising the gap fill).
 */
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

let THREAD = "th-fake-1";
let turnSeq = 0;

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // responses to OUR server requests (the approval)
  if (msg.method === undefined && msg.id !== undefined) {
    const decision = msg.result?.decision ?? "no-decision";
    notify("item/completed", {
      threadId: THREAD,
      turnId: `turn-${turnSeq}`,
      item: {
        type: "commandExecution",
        id: "exec-1",
        command: "echo hi",
        cwd: "/tmp",
        status: decision === "accept" || decision === "acceptForSession" ? "completed" : "declined",
        aggregatedOutput: `decision=${JSON.stringify(decision)}`,
        exitCode: decision === "accept" || decision === "acceptForSession" ? 0 : 1,
      },
    });
    finishTurn();
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake" } });
      break;
    case "initialized":
      break;
    case "thread/start":
      send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: THREAD, startedFresh: true } } });
      break;
    case "thread/resume":
      THREAD = msg.params.threadId;
      send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: THREAD, resumed: true } } });
      break;
    case "turn/start": {
      turnSeq += 1;
      const turnId = `turn-${turnSeq}`;
      send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
      notify("item/agentMessage/delta", { threadId: THREAD, turnId, itemId: "msg-1", delta: "hel" });
      notify("item/agentMessage/delta", { threadId: THREAD, turnId, itemId: "msg-1", delta: "lo" });
      notify("item/started", {
        threadId: THREAD,
        turnId,
        item: { type: "commandExecution", id: "exec-1", command: "echo hi", cwd: "/tmp", status: "inProgress" },
      });
      // approval round-trip: our own server->client request, id 900
      send({
        jsonrpc: "2.0",
        id: 900,
        method: "item/commandExecution/requestApproval",
        params: { threadId: THREAD, turnId, itemId: "exec-1", command: "echo hi", cwd: "/tmp" },
      });
      break;
    }
    case "turn/interrupt":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      notify("turn/completed", {
        threadId: THREAD,
        turn: { id: `turn-${turnSeq}`, status: "interrupted", error: null },
      });
      break;
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown: ${msg.method}` } });
      break;
  }
});

function finishTurn() {
  const turnId = `turn-${turnSeq}`;
  notify("thread/tokenUsage/updated", {
    threadId: THREAD,
    turnId,
    tokenUsage: {
      total: { totalTokens: 100, inputTokens: 60, cachedInputTokens: 10, cacheWriteInputTokens: 5, outputTokens: 40, reasoningOutputTokens: 0 },
      last: { totalTokens: 50, inputTokens: 30, cachedInputTokens: 8, cacheWriteInputTokens: 2, outputTokens: 20, reasoningOutputTokens: 0 },
      modelContextWindow: 200000,
    },
  });
  notify("item/completed", {
    threadId: THREAD,
    turnId,
    item: { type: "agentMessage", id: "msg-1", text: "hello there" },
  });
  notify("turn/completed", { threadId: THREAD, turn: { id: turnId, status: "completed", error: null } });
}
