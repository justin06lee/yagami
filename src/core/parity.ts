import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";

/**
 * How closely an embedded session should mirror the interactive `claude`
 * terminal. This resolves the single most common surprise in library mode:
 * the Agent SDK loads none of your settings by default.
 *
 * - `"terminal"` — behave like your CLI: load user + project + local
 *   settings, so CLAUDE.md, skills, hooks, and .mcp.json all apply.
 * - `"isolated"` — load nothing (the raw SDK default); the app supplies
 *   everything explicitly. Best when the session must be reproducible or
 *   must not pick up the developer's personal config.
 * - `"project"` — load project + local settings but not the user's global
 *   ones: shared repo config without personal CLAUDE.md/skills.
 */
export type Parity = "terminal" | "project" | "isolated";

const SETTING_SOURCES: Record<Parity, SettingSource[]> = {
  terminal: ["user", "project", "local"],
  project: ["project", "local"],
  isolated: [],
};

/** The `settingSources` a parity level maps to. */
export function settingSourcesFor(parity: Parity): SettingSource[] {
  return [...SETTING_SOURCES[parity]];
}
