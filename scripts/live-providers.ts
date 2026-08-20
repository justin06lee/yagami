/**
 * Live multi-provider check against the real CLIs on this machine.
 * Costs a few tokens on each signed-in subscription — run manually:
 *   bun run live:providers
 */
import { startYagami } from "../src/server.js";

const KEY = "ygm_live_providers";
const running = await startYagami({ host: "127.0.0.1", port: 0, apiKeys: [KEY], log: null });
const headers = { "content-type": "application/json", "x-api-key": KEY };
const engine = running.engine;
console.log(`providers: ${engine.providerIds.join(", ")} (default ${engine.defaultProviderId})`);
for (const [id, why] of engine.unavailable) if (["codex", "opencode", "gemini"].includes(id)) console.log(`  unavailable ${id}: ${why}`);

const mres = await fetch(`${running.url}/v1/models`, { headers });
const models = (await mres.json()) as { data: Array<{ id: string }> };
const byProvider = new Map<string, number>();
for (const m of models.data) {
  const p = m.id.includes(":") ? m.id.split(":")[0]! : "(bare)";
  byProvider.set(p, (byProvider.get(p) ?? 0) + 1);
}
console.log(`[models] source=${mres.headers.get("x-yagami-models-source")} ${[...byProvider].map(([p, n]) => `${p}=${n}`).join(" ")}`);

const targets: Array<[string, string | undefined]> = [
  ["claude", "sonnet"],
  ["codex", "codex"],
  ["opencode", "opencode:opencode/deepseek-v4-flash-free"],
];
const results: Record<string, boolean> = {};
for (const [name, model] of targets) {
  if (!engine.providers.has(name)) {
    console.log(`[${name}] skipped (not available)`);
    continue;
  }
  const t = Date.now();
  const res = await fetch(`${running.url}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: "user", content: "Reply with exactly: pong" }] }),
  });
  const body = (await res.json()) as { content?: Array<{ type: string; text?: string }>; model?: string; error?: { message: string } };
  const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  console.log(
    `[${name}] ${res.status} ${((Date.now() - t) / 1000).toFixed(1)}s provider=${res.headers.get("x-yagami-provider")} model=${body.model} session=${res.headers.get("x-yagami-session")?.slice(0, 12)} reply=${JSON.stringify(text || body.error?.message)}`,
  );
  results[name] = res.ok && text.toLowerCase().includes("pong");

  // follow-up through the session-resume path
  if (res.ok) {
    const t2 = Date.now();
    const res2 = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [
          { role: "user", content: "Reply with exactly: pong" },
          { role: "assistant", content: text },
          { role: "user", content: "Now say that same word in uppercase, nothing else." },
        ],
      }),
    });
    const body2 = (await res2.json()) as { content?: Array<{ type: string; text?: string }>; error?: { message: string } };
    const text2 = (body2.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    console.log(`  follow-up ${res2.status} ${((Date.now() - t2) / 1000).toFixed(1)}s reply=${JSON.stringify(text2 || body2.error?.message)}`);
    results[`${name}-followup`] = res2.ok && text2.includes("PONG");
  }
}

// streaming through a non-default provider
if (engine.providers.has("codex")) {
  const res = await fetch(`${running.url}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "codex", max_tokens: 64, stream: true, messages: [{ role: "user", content: "Count from 1 to 3, one number per line." }] }),
  });
  const raw = await res.text();
  const types = [...new Set([...raw.matchAll(/^event: (.+)$/gm)].map((m) => m[1]))];
  console.log(`[codex stream] ${res.status} events=${types.join(",")}`);
  results["codex-stream"] = types.includes("message_start") && types.includes("message_stop") && raw.includes("text_delta");
}

await running.close();
const failed = Object.entries(results).filter(([, ok]) => !ok).map(([k]) => k);
console.log(failed.length === 0 ? "\nLIVE PROVIDERS PASS" : `\nLIVE PROVIDERS FAIL: ${failed.join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
