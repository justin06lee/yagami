import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderNotInstalledError } from "./errors.js";

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

/** Directories CLIs commonly install into when they aren't on PATH. */
function commonBinDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
  ];
}

export interface FindExecutableOptions {
  /** Explicit path from config/CLI flags; wins when set, errors when wrong. */
  explicit?: string;
  /** Extra absolute candidates to try after PATH. */
  extraPaths?: string[];
}

/**
 * Locate a CLI binary: explicit path first, then PATH, then the usual
 * install directories. Returns undefined when nothing is found.
 */
export function findExecutable(name: string, options: FindExecutableOptions = {}): string | undefined {
  if (options.explicit) {
    const p = expandHome(options.explicit);
    return isFile(p) ? p : undefined;
  }
  if (name.includes("/")) {
    const p = expandHome(name);
    return isFile(p) ? p : undefined;
  }
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  for (const dir of commonBinDirs()) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  for (const candidate of options.extraPaths ?? []) {
    if (isFile(expandHome(candidate))) return expandHome(candidate);
  }
  return undefined;
}

/** Like findExecutable, but throws a typed, actionable error when missing. */
export function resolveExecutable(
  providerId: string,
  name: string,
  installHint: string,
  options: FindExecutableOptions = {},
): string {
  const found = findExecutable(name, options);
  if (found) return found;
  const detail = options.explicit ? `configured path ${options.explicit} does not exist` : `\`${name}\` not on PATH`;
  throw new ProviderNotInstalledError(providerId, installHint, detail);
}

/**
 * Locate the user's installed (and signed-in) Claude Code CLI. The resolved
 * path is handed to the Agent SDK via `pathToClaudeCodeExecutable`, so the
 * spawned engine is the same binary — and the same login — the user gets in
 * their terminal.
 */
export function resolveClaudeExecutable(explicit?: string): string {
  const configured = explicit ?? process.env["YAGAMI_CLAUDE_PATH"];
  return resolveExecutable(
    "claude",
    "claude",
    "Install Claude Code and sign in (run `claude`, then /login), or point yagami at it with YAGAMI_CLAUDE_PATH or providers.claude.path.",
    {
      ...(configured ? { explicit: configured } : {}),
      extraPaths: [path.join(os.homedir(), ".claude", "local", "claude")],
    },
  );
}
