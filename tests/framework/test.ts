type Test = { name: string; fn: () => Promise<void> | void };
const registry: Test[] = [];

export function test(name: string, fn: () => Promise<void> | void) {
  registry.push({ name, fn });
}

export async function runAll() {
  let passed = 0;
  for (const t of registry) {
    try {
      await t.fn();
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
}
