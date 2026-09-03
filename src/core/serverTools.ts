import { ApiError } from "./types.js";

/**
 * Anthropic **server tools** — the ones that execute on the provider's side
 * rather than being handed back to the client as `tool_use` blocks.
 *
 * Everything else about yagami stays completions-only: it still never emits a
 * `tool_use` block or asks the caller to run anything. But a caller that says
 * "you may search the web" is not asking for a client tool loop, it is asking
 * the engine to go look something up before answering — and the backing CLIs
 * already have exactly those tools. Declining that made yagami unusable for
 * any research-shaped request, which was a gap rather than a design choice.
 *
 * Custom (client-executed) tools remain unsupported, and still fail loudly.
 */

/** Claude Code's name for each Anthropic server tool type. */
const SERVER_TOOLS: Record<string, string> = {
  web_search: "WebSearch",
  web_fetch: "WebFetch",
};

/** Tool `type` strings are versioned (`web_search_20260209`); the prefix is the identity. */
export function serverToolFor(type: unknown): string | undefined {
  if (typeof type !== "string") return undefined;
  for (const [prefix, tool] of Object.entries(SERVER_TOOLS)) {
    if (type === prefix || type.startsWith(`${prefix}_`)) return tool;
  }
  return undefined;
}

/**
 * Resolve a request's `tools` array to the CLI tool names to enable.
 *
 * Returns `undefined` when no tools were requested. Throws on custom tools,
 * which genuinely cannot work here — there is no round trip to run them on.
 */
export function resolveServerTools(tools: unknown, toolChoice?: unknown): string[] | undefined {
  if (tools == null) {
    if (toolChoice != null) {
      throw new ApiError(
        400,
        "invalid_request_error",
        "`tool_choice` was given without `tools`.",
      );
    }
    return undefined;
  }
  if (!Array.isArray(tools)) {
    throw new ApiError(400, "invalid_request_error", "`tools` must be an array");
  }
  if (tools.length === 0) return undefined;

  const resolved = new Set<string>();
  for (const tool of tools) {
    const entry = tool as { type?: unknown; name?: unknown };
    const mapped = serverToolFor(entry?.type);
    if (!mapped) {
      const label =
        typeof entry?.name === "string"
          ? `"${entry.name}"`
          : `type "${String(entry?.type)}"`;
      throw new ApiError(
        400,
        "invalid_request_error",
        `yagami supports Anthropic server tools (${Object.keys(SERVER_TOOLS).join(", ")}) ` +
          `but not custom tools: ${label} would have to be executed by you, and this endpoint ` +
          `never emits tool_use blocks. Drop it, or ask for the result as text/JSON instead.`,
      );
    }
    resolved.add(mapped);
  }

  // `tool_choice` picks between client tools; with server tools there is
  // nothing to force, so anything but `auto`/`none` is meaningless here.
  const choice = (toolChoice as { type?: unknown } | undefined)?.type;
  if (choice != null && choice !== "auto" && choice !== "none") {
    throw new ApiError(
      400,
      "invalid_request_error",
      `\`tool_choice.type\` must be "auto" or "none" with server tools (got "${String(choice)}"): ` +
        `server tools run on the engine's side and cannot be forced.`,
    );
  }
  if (choice === "none") return undefined;

  return [...resolved];
}
