/**
 * Request 1M without freezing the installed CLI's live family aliases.
 * Yagami's empty/default selection is Sonnet (never implicit paid Fable).
 * Unknown IDs and special modes such as opusplan remain CLI-owned. An
 * unavailable 1M selection must fail, never retry with a smaller window.
 */
export function claudeLongContextModel(model: string): string {
  if (model === "" || model === "default") return "sonnet[1m]";
  if (model.endsWith("[1m]")) return model;
  if (/^(?:opus|sonnet|haiku|fable|best)$/.test(model) || /^claude-(?:opus|sonnet|haiku|fable)-\d+(?:-\d+)*$/.test(model)) {
    return `${model}[1m]`;
  }
  return model;
}

/** Effective primary-model capacity; never mistake a subagent's usage for it. */
export function claudeResultContextWindow(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
  model?: string,
): number | undefined {
  const entries = Object.entries(modelUsage ?? {});
  const canonical = (id: string) => id.replace(/\[1m\]$/, "");
  const row = model
    ? entries.find(([id]) => canonical(id) === canonical(model))?.[1]
    : entries.length === 1 ? entries[0]?.[1] : undefined;
  const capacity = row?.contextWindow;
  return typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0 ? capacity : undefined;
}
