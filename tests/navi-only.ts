import "./cases/aiAssistant.test";
import "./cases/aiHttpRetry.test";
import "./cases/aiHistoricalState.test";
import "./cases/aiKnowledgeQc.test";
import "./cases/naviPrompt.test";
import { runAll } from "./framework/test";

// Targeted offline AI suite; no unmocked network or production services.
const previousFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("Unmocked network fetch in offline AI test suite");
}) as typeof fetch;
void runAll().finally(() => {
  globalThis.fetch = previousFetch;
});
