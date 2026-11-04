function checkLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('并发数必须为正整数');
}

/** FIFO admission; cancelling a queued job never occupies a running slot. */
export class TaskLimiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private limit: number) { checkLimit(limit); }
  setLimit(limit: number) { checkLimit(limit); this.limit = limit; this.pump(); }
  private pump() { while (this.active < this.limit && this.queue.length) this.queue.shift()!(); }
  run<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const abort = () => {
        const index = this.queue.indexOf(start);
        if (index < 0) return;
        this.queue.splice(index, 1); signal?.removeEventListener('abort', abort); reject(signal?.reason);
      };
      const start = () => {
        signal?.removeEventListener('abort', abort);
        this.active++;
        const finish = () => { this.active--; this.pump(); };
        Promise.resolve().then(() => { signal?.throwIfAborted(); return action(); }).then(
          value => { finish(); resolve(value); },
          error => { finish(); reject(error); },
        );
      };
      this.queue.push(start); signal?.addEventListener('abort', abort, { once: true }); this.pump();
    });
  }
}

/** Stop scheduling on the first error, but drain started actions before returning. */
export async function concurrentBatch<T, R>(items: readonly T[], limit: number, action: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  checkLimit(limit); signal?.throwIfAborted();
  const result = new Array<R>(items.length);
  let next = 0; let failed = false; let failure: unknown;
  const work = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { signal?.throwIfAborted(); result[index] = await action(items[index], index); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  if (failed) throw failure;
  return result;
}
