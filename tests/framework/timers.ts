export async function withImmediateTimers<T>(
  fn: () => Promise<T> | T
): Promise<T> {
  const origSetTimeout = global.setTimeout;
  const origClearTimeout = global.clearTimeout;
  (global as any).setTimeout = (
    cb: (...args: any[]) => any,
    _ms?: number,
    ...args: any[]
  ) => {
    const handle = setImmediate(() => {
      try {
        cb(...args);
      } catch (e) {
        // Bubble up async to avoid breaking scheduler flow
        setImmediate(() => {
          throw e;
        });
      }
    });
    return handle as any;
  };
  (global as any).clearTimeout = (_t: any) => {};

  try {
    return await fn();
  } finally {
    (global as any).setTimeout = origSetTimeout as any;
    (global as any).clearTimeout = origClearTimeout as any;
  }
}
