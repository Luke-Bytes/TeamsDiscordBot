export function assert(condition: any, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function assertEqual<T>(a: T, b: T, message: string) {
  if (a !== b) {
    throw new Error(`Assertion failed: ${message}. Expected ${b}, got ${a}`);
  }
}
