/**
 * Live check of the harness catalog against the real CLIs on this machine:
 * the list a host would show (installed, signed in), each signed-in
 * harness's models, and one tiny turn through each. Costs a few tokens on
 * every signed-in subscription — run manually:
 *   bun run live:harnesses            # list + models + a turn each
 *   bun run live:harnesses -- --list  # the list only, no turns
 *   bun run live:harnesses -- grok antigravity   # only these
 */
import { Yagami, UsageLimitError } from "../src/index.js";

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const only = args.filter((a) => !a.startsWith("--"));

const yagami = new Yagami();
const started = Date.now();
const harnesses = await yagami.harnesses();
console.log(`[1/3] ${harnesses.length} harnesses known, checked in ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const h of harnesses.filter((h) => h.installed)) {
  const state = h.signedIn === true ? `signed in${h.account ? ` as ${h.account.replace(/^[^@]*/, "…")}` : ""}${h.plan ? ` (${h.plan})` : ""}` : h.signedIn === false ? `NOT signed in — ${h.loginCommand}` : `sign-in unknown${h.detail ? ` — ${h.detail}` : ""}`;
  console.log(`  ${h.isDefault ? "*" : " "} ${h.id.padEnd(12)} ${h.label.padEnd(22)} ${h.kind.padEnd(6)} ${state}`);
}
console.log(`    not installed: ${harnesses.filter((h) => !h.installed).map((h) => h.id).join(", ")}`);
if (listOnly) process.exit(0);

const targets = harnesses.filter((h) => h.available && (only.length === 0 || only.includes(h.id)));
const results: Record<string, boolean> = {};
let step = 0;
for (const h of targets) {
  step += 1;
  console.log(`[2/3] (${step}/${targets.length}) ${h.id}: models`);
  let model: string | undefined;
  try {
    const t = Date.now();
    const models = await yagami.models.for(h.id);
    model = models[0]?.id;
    console.log(`  ${models.length} models in ${((Date.now() - t) / 1000).toFixed(1)}s; first: ${models.slice(0, 4).map((m) => `${m.id}${m.is_default ? "*" : ""}${m.context_window ? ` [${m.context_window} ${m.context_window_source}]` : ""}`).join(", ")}`);
  } catch (err) {
    console.log(`  models FAILED: ${(err as Error).name}: ${(err as Error).message.slice(0, 200)}`);
  }
  console.log(`[3/3] (${step}/${targets.length}) ${h.id}: one turn`);
  try {
    const t = Date.now();
    const r = await yagami.turn({ harness: h.id, system: "You answer in one word.", text: "Reply with exactly: pong" });
    results[h.id] = r.text.toLowerCase().includes("pong");
    console.log(`  ${((Date.now() - t) / 1000).toFixed(1)}s model=${r.model} text=${JSON.stringify(r.text.slice(0, 60))} usage=${JSON.stringify(r.usage)}${r.contextWindow ? ` context=${r.contextWindow}` : ""}${r.limits ? ` limits=${JSON.stringify(r.limits)}` : ""}${r.ignored.length ? ` ignored=${r.ignored}` : ""}`);
  } catch (err) {
    results[h.id] = false;
    const limit = err instanceof UsageLimitError ? ` resetsAt=${err.resetsAt}` : "";
    console.log(`  turn FAILED: ${(err as Error).name}: ${(err as Error).message.slice(0, 200)}${limit}`);
  }
}
const failed = Object.entries(results).filter(([, ok]) => !ok).map(([id]) => id);
console.log(failed.length === 0 ? `\nLIVE HARNESSES PASS (${Object.keys(results).join(", ")})` : `\nLIVE HARNESSES FAIL: ${failed.join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
