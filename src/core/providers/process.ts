import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { debug } from "../log.js";

/**
 * Ending a CLI for good.
 *
 * `child.kill()` signals the one process yagami spawned, and several CLIs are
 * not one process: Gemini's launcher re-executes itself as a child with a
 * bigger heap, npm-installed CLIs sit behind a node shim, and an agent's MCP
 * servers hang off the agent. Signal only the top and the rest can outlive
 * it — reparented to launchd, holding hundreds of megabytes, for as long as
 * the machine stays up. So the whole tree is found first and every process
 * in it is asked to go; anything still there after a grace period is killed
 * outright.
 */

/** How long a tree gets to exit on SIGTERM before SIGKILL follows. */
const GRACE_MS = 3000;

/** Children already on their way out — a second call is a no-op. */
const ending = new WeakSet<ChildProcess>();

/** Every descendant of `root`, found from one `ps` listing. */
function descendants(root: number): number[] {
  let listing: string;
  try {
    listing = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2000 });
  } catch (err) {
    debug("process", `could not list processes; only pid ${root} itself will be signalled`, err);
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const found: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

/**
 * Stop a spawned CLI and everything it started. Safe to call more than once
 * and on a process that has already exited.
 */
export function killTree(child: ChildProcess | undefined | null, graceMs = GRACE_MS): void {
  if (!child || child.pid === undefined || ending.has(child)) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  ending.add(child);
  const pid = child.pid;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // listed before anything is signalled: once the top exits, its children
  // are reparented and can no longer be found by walking down from it
  const tree = [pid, ...descendants(pid)];
  for (const member of tree) signal(member, "SIGTERM");
  const timer = setTimeout(() => {
    for (const member of tree) if (isAlive(member)) signal(member, "SIGKILL");
  }, graceMs);
  timer.unref?.();
}
