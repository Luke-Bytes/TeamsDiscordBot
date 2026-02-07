type Test = { name: string; fn: () => Promise<void> | void };
const registry: Test[] = [];
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;

export function test(name: string, fn: () => Promise<void> | void) {
  registry.push({ name, fn });
}

export async function runAll() {
  let passed = 0;
  for (const t of registry) {
    try {
      const timeout = 5_000;
      let timeoutId: any;
      await Promise.race([
        Promise.resolve(t.fn()),
        new Promise<void>((_, reject) => {
          timeoutId = realSetTimeout(() => {
            reject(new Error(`Test timeout after ${timeout}ms`));
          }, timeout);
        }),
      ]);
      if (timeoutId) realClearTimeout(timeoutId);
      console.log(`✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`✗ ${t.name}`);
      console.error(e);
      process.exitCode = 1;
    }
  }
  if (registry.length === 0) {
    console.warn("No tests registered.");
  } else {
    console.log(`Finished: ${passed}/${registry.length} passed.`);
  }
  setImmediate(() => {
    process.exit(process.exitCode ?? 0);
  });
}
