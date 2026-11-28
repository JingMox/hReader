// This layer: the process-wide thumbnail generation queue — FIFO drain, at most
// one concurrent generation, and single-flight per cache key (a second `submit`
// for an in-flight key joins the same run instead of queueing a duplicate).
// A Chrome session is the expensive resource here; the queue is what bounds it.
// Timeouts are not the queue's business: a deadline-bound `work` simply rejects,
// and the next pending run starts — the queue itself stays usable.

interface Pending {
  readonly key: string;
  readonly work: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export interface RenderQueue {
  /**
   * Enqueue `work` under `key`. While that key's run is unsettled a later
   * `submit` of the same key shares this run's promise — a duplicate never
   * reaches the queue. Runs settle and the key is forgotten independently of
   * when sharers observe the result.
   */
  readonly submit: <T>(key: string, work: () => Promise<T>) => Promise<T>;
}

export const createRenderQueue = (): RenderQueue => {
  const pending: Pending[] = [];
  const inflight = new Map<string, Promise<unknown>>();
  let running = false;

  const drain = (): void => {
    if (running) return;
    const next = pending.shift();
    if (next === undefined) return;
    running = true;
    void step(next);
  };

  const step = async (next: Pending): Promise<void> => {
    try {
      next.resolve(await next.work());
    } catch (error: unknown) {
      next.reject(error);
    } finally {
      // Forget the key before the sharers' continuations run: a same-key submit
      // racing the settle must start a fresh generation, not join the dead one.
      inflight.delete(next.key);
      running = false;
      drain();
    }
  };

  return {
    submit: <T>(key: string, work: () => Promise<T>): Promise<T> => {
      const shared = inflight.get(key);
      if (shared !== undefined) return shared as Promise<T>;
      const promise = new Promise<T>((resolve, reject) => {
        pending.push({
          key,
          work,
          // The settled value always comes from this entry's own `work` — erasing
          // to `unknown` at the queue boundary and restoring `T` here is exact.
          resolve: (value) => {
            resolve(value as T);
          },
          reject,
        });
      });
      inflight.set(key, promise);
      drain();
      return promise;
    },
  };
};
