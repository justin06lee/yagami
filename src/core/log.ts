/**
 * The one place failures yagami deliberately survives are reported from.
 *
 * Plenty of code paths catch an error and carry on by design — a probe that
 * failed, a best-effort mode switch, a handler that threw. Carrying on is
 * right; carrying on *silently* is how "sessions never persist" and "the
 * model list is always the fallback" go unnoticed for weeks. So every such
 * catch says what it swallowed, through here, and a host can point the
 * output wherever it likes.
 */

export type LogSink = (line: string) => void;

const stderr: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

let sink: LogSink = stderr;

/**
 * Route yagami's diagnostics somewhere other than stderr. `null` restores
 * the default; `() => {}` silences them.
 */
export function setLogSink(fn: LogSink | null): void {
  sink = fn ?? stderr;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Something the user should know about even though yagami kept going. */
export function warn(scope: string, message: string, err?: unknown): void {
  sink(`yagami: ${scope}: ${message}${err !== undefined ? ` (${describe(err)})` : ""}`);
}

/** Expected, recoverable noise — reported only when YAGAMI_DEBUG is set. */
export function debug(scope: string, message: string, err?: unknown): void {
  if (!process.env["YAGAMI_DEBUG"]) return;
  warn(scope, message, err);
}
