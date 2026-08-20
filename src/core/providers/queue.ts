/**
 * Minimal unbounded async queue: producers push, one consumer iterates.
 * `end()` completes the iteration once the buffer drains; `fail()` rejects
 * the consumer with the given error.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiting: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | null = null;
  private ended = false;
  private error: unknown = undefined;

  push(value: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve({ value: undefined as never, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.ended) return;
    this.error = err;
    this.ended = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(err);
    }
  }

  get closed(): boolean {
    return this.ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        if (this.error !== undefined) {
          const e = this.error;
          this.error = undefined;
          return Promise.reject(e);
        }
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
      return: () => {
        this.ended = true;
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
