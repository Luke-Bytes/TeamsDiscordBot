import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { Scheduler } from "../../src/util/SchedulerUtil";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test("resetCurrentGame cancels scheduled map/minerush vote tasks", async () => {
  // Arrange: schedule tasks that would mutate state if they fired.
  let mapFired = 0;
  let minerushFired = 0;

  Scheduler.schedule(
    "mapVote",
    () => {
      mapFired++;
    },
    new Date(Date.now() + 80)
  );

  Scheduler.schedule(
    "minerushVote",
    () => {
      minerushFired++;
    },
    new Date(Date.now() + 80)
  );

  // Act: reset should cancel scheduler tasks even if no vote managers exist.
  await CurrentGameManager.resetCurrentGame();

  // Wait long enough that tasks would have fired if not canceled.
  await sleep(150);

  // Assert
  assert(mapFired === 0, `expected mapVote task not to fire (got ${mapFired})`);
  assert(
    minerushFired === 0,
    `expected minerushVote task not to fire (got ${minerushFired})`
  );
});
