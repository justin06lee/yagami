/**
 * Live check of the AgentSession layer against the real Claude CLI:
 * warm session, a real tool call routed through the permission adapter,
 * interrupt/close. Costs a few tokens — run manually: bun run live:session
 */
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentSession } from "../src/core/agentSession.js";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "yagami-session-"));
fs.writeFileSync(path.join(cwd, "secret.txt"), "the password is swordfish\n");

const asked: string[] = [];
const session = new AgentSession({
  cwd,
  parity: "isolated", // don't pull the developer's CLAUDE.md into the test
  permission: { autoAllow: ["Read", "LS", "Glob", "Grep"] },
  onPermission: async (req) => {
    asked.push(req.toolName);
    return { behavior: "deny", message: "denied by test host" };
  },
});

session.send("Read secret.txt in the current directory and tell me the password, then stop.");

let sawText = "";
let sawToolUse = false;
for await (const msg of session) {
  if (msg.type === "system" && msg.subtype === "init") console.log(`session ${msg.session_id} started, model ${msg.model}`);
  if (msg.type === "assistant") {
    for (const block of msg.message.content as Array<{ type: string; text?: string; name?: string }>) {
      if (block.type === "text" && block.text) sawText += block.text;
      if (block.type === "tool_use") { sawToolUse = true; console.log(`  tool_use: ${block.name}`); }
    }
  }
  if (msg.type === "result") {
    console.log(`result: ${msg.subtype}, cost $${(msg.total_cost_usd ?? 0).toFixed(6)}`);
    break;
  }
}
session.close();

console.log(`reply: ${JSON.stringify(sawText.trim().slice(0, 200))}`);
console.log(`permission asks: ${asked.join(", ") || "(none)"}`);
const ok = sawToolUse && sawText.toLowerCase().includes("swordfish");
console.log(ok ? "\nLIVE SESSION PASS" : "\nLIVE SESSION FAIL");
fs.rmSync(cwd, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
