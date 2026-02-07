export async function withImmediateTimers<T>(
  fn: () => Promise<T> | T
): Promise<T> {
  const origSetTimeout = global.setTimeout;
  const origClearTimeout = global.clearTimeout;
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  type TimerHandle = { canceled: boolean };
  (global as any).setTimeout = (
    cb: (...args: any[]) => any,
    _ms?: number,
    ...args: any[]
  ) => {
    const handle: TimerHandle = { canceled: false };
    setImmediate(async () => {
      if (handle.canceled) return;
      try {
        const result = cb(...args);
        if (result && typeof (result as any).then === "function") {
          await result;
        }
      } catch (e) {
        // Bubble up async to avoid breaking scheduler flow
        setImmediate(() => {
          throw e;
        });
      }
    });
    return handle as any;
  };
  (global as any).clearTimeout = (t: TimerHandle) => {
    if (t) t.canceled = true;
  };
  (global as any).setInterval = (
    cb: (...args: any[]) => any,
    _ms?: number,
    ...args: any[]
  ) => {
    const handle: TimerHandle = { canceled: false };
    setImmediate(async () => {
      if (handle.canceled) return;
      try {
        const result = cb(...args);
        if (result && typeof (result as any).then === "function") {
          await result;
        }
      } catch (e) {
        setImmediate(() => {
          throw e;
        });
      }
    });
    return handle as any;
  };
  (global as any).clearInterval = (t: TimerHandle) => {
    if (t) t.canceled = true;
  };

  try {
    return await fn();
  } finally {
    (global as any).setTimeout = origSetTimeout as any;
    (global as any).clearTimeout = origClearTimeout as any;
    (global as any).setInterval = origSetInterval as any;
    (global as any).clearInterval = origClearInterval as any;
  }
}
