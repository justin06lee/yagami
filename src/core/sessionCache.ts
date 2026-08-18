import * as fs from "node:fs";
import * as path from "node:path";

export interface SessionCacheOptions {
  maxEntries?: number;
  /** JSON file to persist the cache across restarts (best-effort). */
  persistPath?: string;
}

/**
 * LRU map from conversation-prefix hash to Claude Code session id.
 * Session transcripts themselves live in ~/.claude; this only remembers
 * which session corresponds to which conversation prefix.
 */
export class SessionCache {
  private readonly map = new Map<string, string>();
  private readonly maxEntries: number;
  private readonly persistPath: string | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SessionCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.persistPath = options.persistPath;
    this.load();
  }

  get size(): number {
    return this.map.size;
  }

  get(key: string): string | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, sessionId: string): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, sessionId);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.schedulePersist();
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, "utf8")) as {
        entries?: Array<[string, string]>;
      };
      for (const [key, value] of raw.entries ?? []) {
        if (typeof key === "string" && typeof value === "string") this.map.set(key, value);
      }
    } catch {
      // missing or corrupt cache file — start empty
    }
  }

  private schedulePersist(): void {
    if (!this.persistPath) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), 200);
    this.persistTimer.unref?.();
  }

  persistNow(): void {
    if (!this.persistPath) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(
        this.persistPath,
        JSON.stringify({ version: 1, entries: [...this.map] }),
        { mode: 0o600 },
      );
    } catch {
      // persistence is best-effort; the cache still works in memory
    }
  }
}
