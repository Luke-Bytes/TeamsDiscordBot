// Separate from the permanent test runner. No production connections.
import "./scenarioMatchFlows.test";
import "./impostorMatchFlow.test";
import "./scenarioFailureFlows.test";
import { runAll } from "../framework/test";

globalThis.fetch = (async () => {
  throw new Error("Scenario match tests must not use HTTP");
}) as typeof fetch;
void runAll();
