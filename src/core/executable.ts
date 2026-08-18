import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function commonInstallPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(home, ".claude", "local", "claude"),
    path.join(home, ".npm-global", "bin", "claude"),
    path.join(home, "bin", "claude"),
  ];
}

/**
 * Locate the user's installed (and signed-in) Claude Code CLI. The resolved
 * path is handed to the Agent SDK via `pathToClaudeCodeExecutable`, so the
 * spawned engine is the same binary — and the same login — the user gets in
 * their terminal.
 */
export function resolveClaudeExecutable(explicit?: string): string {
  const configured = explicit ?? process.env["YAGAMI_CLAUDE_PATH"];
  if (configured) {
    const p = expandHome(configured);
    if (isFile(p)) return p;
    throw new Error(`claude executable not found at configured path: ${configured}`);
  }

  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    if (isFile(candidate)) return candidate;
  }

  for (const candidate of commonInstallPaths()) {
    if (isFile(candidate)) return candidate;
  }

  throw new Error(
    "Could not find the Claude Code CLI (`claude`). Install it and sign in " +
      "(run `claude` and use /login), or point yagami at it with " +
      "YAGAMI_CLAUDE_PATH or the `claudePath` config option.",
  );
}
