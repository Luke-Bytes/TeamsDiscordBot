// Explicitly independent of tests/run.ts: no live network or database calls.
import "./recoverGameStress.test";
import { runAll } from "../framework/test";

const previousFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("Temporary recovery tests must not make HTTP requests");
}) as typeof fetch;
void runAll().finally(() => {
  globalThis.fetch = previousFetch;
});
