/**
 * End-to-end smoke test against the real Claude Code CLI.
 * Costs a few real tokens — run manually: pnpm smoke
 */
import { startYagami } from "../src/server.js";

const KEY = "ygm_smoke_local_only";
const MODEL = process.env["YAGAMI_SMOKE_MODEL"] ?? "sonnet";

const running = await startYagami({ host: "127.0.0.1", port: 0, apiKeys: [KEY] });
console.log(`server up at ${running.url} (claude: ${running.engine.claudePath})`);

const headers = { "content-type": "application/json", "x-api-key": KEY };

// 1. non-streaming completion
console.log("\n[1/3] non-streaming completion…");
let t = Date.now();
const res1 = await fetch(`${running.url}/v1/messages`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 64,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
  }),
});
const body1 = (await res1.json()) as {
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  usage?: unknown;
};
if (!res1.ok) {
  console.error("FAIL", res1.status, JSON.stringify(body1));
  process.exit(1);
}
const text1 = (body1.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
console.log(`  ${res1.status} in ${((Date.now() - t) / 1000).toFixed(1)}s — model=${body1.model} cost=$${res1.headers.get("x-yagami-cost-usd")}`);
console.log(`  reply: ${JSON.stringify(text1)}`);
console.log(`  usage: ${JSON.stringify(body1.usage)}`);

// 2. multi-turn follow-up: exercises the session-resume path
console.log("\n[2/3] multi-turn follow-up (session resume)…");
t = Date.now();
const res2 = await fetch(`${running.url}/v1/messages`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 64,
    messages: [
      { role: "user", content: "Reply with exactly: pong" },
      { role: "assistant", content: text1 },
      { role: "user", content: "Now say that same word in uppercase, nothing else." },
    ],
  }),
});
const body2 = (await res2.json()) as { content?: Array<{ type: string; text?: string }> };
const text2 = (body2.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
console.log(`  ${res2.status} in ${((Date.now() - t) / 1000).toFixed(1)}s — session=${res2.headers.get("x-yagami-session")}`);
console.log(`  reply: ${JSON.stringify(text2)}`);

// 3. streaming
console.log("\n[3/3] streaming…");
t = Date.now();
const res3 = await fetch(`${running.url}/v1/messages`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "Count from 1 to 5, one number per line." }],
  }),
});
if (!res3.ok || !res3.body) {
  console.error("FAIL", res3.status, await res3.text());
  process.exit(1);
}
const reader = res3.body.getReader();
const decoder = new TextDecoder();
let raw = "";
let firstEventAt: number | undefined;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  if (firstEventAt === undefined) firstEventAt = Date.now();
  raw += decoder.decode(value, { stream: true });
}
const eventTypes = [...raw.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
const streamedText = [...raw.matchAll(/"text_delta","text":"((?:[^"\\]|\\.)*)"/g)]
  .map((m) => JSON.parse(`"${m[1]}"`))
  .join("");
console.log(`  ${res3.status}, first event after ${(((firstEventAt ?? Date.now()) - t) / 1000).toFixed(1)}s, total ${((Date.now() - t) / 1000).toFixed(1)}s`);
console.log(`  events: ${[...new Set(eventTypes)].join(", ")}`);
console.log(`  streamed text: ${JSON.stringify(streamedText)}`);

await running.close();
const ok =
  text1.toLowerCase().includes("pong") &&
  text2.includes("PONG") &&
  eventTypes.includes("message_start") &&
  eventTypes.includes("message_stop") &&
  streamedText.length > 0;
console.log(ok ? "\nSMOKE PASS" : "\nSMOKE FAIL");
process.exit(ok ? 0 : 1);
