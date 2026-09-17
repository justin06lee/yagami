import { ApiError } from "./types.js";

/**
 * Anthropic's **MCP connector** on `/v1/messages`: the caller declares MCP
 * servers in `mcp_servers` and enables them with `mcp_toolset` entries in
 * `tools`. The engine connects to those servers, the model calls their tools
 * during the turn, and the activity comes back as `mcp_tool_use` /
 * `mcp_tool_result` content blocks — exactly the real API's shape.
 *
 * This is how a client-side program gets tools *without* a client tool loop:
 * the tools run wherever the MCP server runs (an editor, a desktop app, a
 * box on the LAN), and the turn stays a single request/response. Custom
 * `tool_use` round trips remain unsupported.
 */

export interface McpServerSpec {
  /** Streamable-HTTP (or SSE) endpoint the harness connects to. */
  url: string;
  /** Extra headers, e.g. an `Authorization` bearer from `authorization_token`. */
  headers?: Record<string, string>;
  /** When set, only these tool names from the server may be called. */
  allowedTools?: string[];
}

export interface ResolvedMcp {
  /** Enabled servers by name (only those an `mcp_toolset` entry referenced). */
  servers: Record<string, McpServerSpec>;
  /** `tools` with the `mcp_toolset` entries removed, for server-tool resolution. */
  remainingTools: unknown;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request_error", message);
}

/**
 * Validate `mcp_servers` + the `mcp_toolset` entries in `tools`.
 *
 * Returns `undefined` when the request declares no MCP servers. Throws
 * {@link ApiError} on malformed input, in the real API's own words where it
 * has them.
 */
export function resolveMcpServers(mcpServers: unknown, tools: unknown): ResolvedMcp | undefined {
  const toolsets: Array<{ server: string; allowed?: string[] }> = [];
  let remainingTools: unknown = tools;
  if (Array.isArray(tools)) {
    const rest: unknown[] = [];
    for (const tool of tools) {
      if (isRecord(tool) && tool["type"] === "mcp_toolset") {
        const server = tool["mcp_server_name"];
        if (typeof server !== "string" || server.length === 0) {
          throw invalid("`mcp_toolset` entries must name a server in `mcp_server_name`");
        }
        const allowed = allowedFromToolset(tool);
        toolsets.push(allowed ? { server, allowed } : { server });
      } else {
        rest.push(tool);
      }
    }
    remainingTools = rest;
  }

  if (mcpServers == null) {
    if (toolsets.length > 0) {
      throw invalid("`tools` references MCP servers with `mcp_toolset` but the request declares no `mcp_servers`");
    }
    return undefined;
  }
  if (!Array.isArray(mcpServers)) {
    throw invalid("`mcp_servers` must be an array");
  }

  const declared = new Map<string, McpServerSpec>();
  for (const [i, entry] of mcpServers.entries()) {
    if (!isRecord(entry)) throw invalid(`mcp_servers[${i}] must be an object`);
    if (entry["type"] !== "url") {
      throw invalid(`mcp_servers[${i}].type must be "url" (got ${JSON.stringify(entry["type"])})`);
    }
    const name = entry["name"];
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      throw invalid(`mcp_servers[${i}].name must be 1-64 characters of letters, digits, "_" or "-"`);
    }
    if (declared.has(name)) throw invalid(`mcp_servers declares "${name}" more than once`);
    const url = entry["url"];
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw invalid(`mcp_servers[${i}].url must be an http(s) URL`);
    }
    const spec: McpServerSpec = { url };
    const token = entry["authorization_token"];
    if (token != null) {
      if (typeof token !== "string" || token.length === 0) {
        throw invalid(`mcp_servers[${i}].authorization_token must be a non-empty string`);
      }
      spec.headers = { Authorization: `Bearer ${token}` };
    }
    const config = entry["tool_configuration"];
    if (config != null) {
      if (!isRecord(config)) throw invalid(`mcp_servers[${i}].tool_configuration must be an object`);
      if (config["enabled"] === false) continue; // declared, deliberately off
      const allowed = config["allowed_tools"];
      if (allowed != null) {
        if (!Array.isArray(allowed) || !allowed.every((t) => typeof t === "string")) {
          throw invalid(`mcp_servers[${i}].tool_configuration.allowed_tools must be an array of tool names`);
        }
        spec.allowedTools = [...(allowed as string[])];
      }
    }
    declared.set(name, spec);
  }

  const servers: Record<string, McpServerSpec> = {};
  for (const { server, allowed } of toolsets) {
    const spec = declared.get(server);
    if (!spec) {
      // A server listed with `enabled: false` is known but off; anything
      // else is a typo the caller wants to hear about.
      const known = (mcpServers as unknown[]).some((e) => isRecord(e) && e["name"] === server);
      if (known) continue;
      throw invalid(`\`mcp_toolset\` references "${server}", which is not declared in \`mcp_servers\``);
    }
    const merged: McpServerSpec = { ...spec };
    if (allowed) {
      merged.allowedTools = spec.allowedTools ? spec.allowedTools.filter((t) => allowed.includes(t)) : [...allowed];
    }
    servers[server] = merged;
  }

  return { servers, remainingTools };
}

/**
 * Per-tool switches on an `mcp_toolset` (`configs: [{ name, enabled }]`)
 * narrow the server's tools to the ones left enabled. `default_config` only
 * matters when it disables everything not listed.
 */
function allowedFromToolset(toolset: Record<string, unknown>): string[] | undefined {
  const configs = toolset["configs"];
  const defaults = toolset["default_config"];
  const defaultEnabled = !(isRecord(defaults) && defaults["enabled"] === false);
  if (!Array.isArray(configs)) return defaultEnabled ? undefined : [];
  const enabled: string[] = [];
  const disabled = new Set<string>();
  for (const c of configs) {
    if (!isRecord(c) || typeof c["name"] !== "string") continue;
    if (c["enabled"] === false) disabled.add(c["name"]);
    else enabled.push(c["name"]);
  }
  if (!defaultEnabled) return enabled;
  // Everything is on by default; an explicit deny list can't be expressed as
  // an allow list without knowing the server's inventory, so it is applied
  // by the provider at call time through the same allow-list mechanism.
  return disabled.size > 0 ? [`!${[...disabled].join("|")}`] : undefined;
}

/** Claude Code names an MCP tool `mcp__<server>__<tool>`. */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice(5);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep === rest.length - 2) return undefined;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/** Whether a resolved server lets the model call this tool. */
export function mcpToolAllowed(spec: McpServerSpec, tool: string): boolean {
  const allowed = spec.allowedTools;
  if (!allowed) return true;
  if (allowed.length === 1 && allowed[0]!.startsWith("!")) {
    return !allowed[0]!.slice(1).split("|").includes(tool);
  }
  return allowed.includes(tool);
}

/** Tool-result content as the model saw it, flattened to one string. */
export function flattenToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") return block["text"];
      return JSON.stringify(block);
    })
    .join("\n");
}
