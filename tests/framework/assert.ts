import { recordTestFailure } from "./test";

function fail(message: string): never {
  const error = new Error(message);
  recordTestFailure(error);
  throw error;
}

export function assert(condition: any, message: string) {
  if (!condition) {
    fail(`Assertion failed: ${message}`);
  }
}

export function assertEqual<T>(a: T, b: T, message: string) {
  if (a !== b) {
    fail(`Assertion failed: ${message}. Expected ${b}, got ${a}`);
  }
}
