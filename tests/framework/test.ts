import { AsyncLocalStorage } from "node:async_hooks";

type Test = { name: string; fn: () => Promise<void> | void };
type TestContext = { failure?: Error; finished: boolean };
const context = new AsyncLocalStorage<TestContext>();

// Preserve assertion and offline-guard failures even if production catches them.
export function recordTestFailure(error: Error): void {
  const current = context.getStore();
  if (current && !current.finished) current.failure ??= error;
  else {
    process.exitCode = 1;
    console.error("Failure outside an active test:", error);
  }
}
const registry: Test[] = [];
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const realSetImmediate = global.setImmediate;
const realExit = process.exit.bind(process);

export function test(name: string, fn: () => Promise<void> | void) {
  registry.push({ name, fn });
}

export async function runAll() {
  let passed = 0;
  for (const t of registry) {
    const current: TestContext = { finished: false };
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = 5_000;
      await Promise.race([
        Promise.resolve().then(() => context.run(current, t.fn)),
        new Promise<void>((_, reject) => {
          timeoutId = realSetTimeout(() => {
            timedOut = true;
            reject(new Error(`Test timeout after ${timeout}ms`));
          }, timeout);
        }),
      ]);
      if (current.failure) throw current.failure;
      console.log(`✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`✗ ${t.name}`);
      console.error(e);
      process.exitCode = 1;
      // Promise.race cannot cancel an in-flight test. Running more tests
      // before its finally blocks execute can leak mocks and fake timers.
      if (timedOut) {
        console.error(
          "Stopping suite after timeout to prevent cascading test failures."
        );
        break;
      }
    } finally {
      current.finished = true;
      if (timeoutId) realClearTimeout(timeoutId);
    }
  }
  if (registry.length === 0) {
    console.error("No tests registered.");
    process.exitCode = 1;
  } else {
    console.log(`Finished: ${passed}/${registry.length} passed.`);
  }
  realSetImmediate(() => {
    realExit(process.exitCode ?? 0);
  });
}
