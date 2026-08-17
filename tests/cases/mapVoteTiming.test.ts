import { AnniMap } from "@prisma/client";
import { GameInstance } from "../../src/database/GameInstance";
import { MapVoteManager } from "../../src/logic/MapVoteManager";
import { Scheduler } from "../../src/util/SchedulerUtil";
import { assert, assertEqual } from "../framework/assert";
import { test } from "../framework/test";

test("map vote finalization is scheduled ten minutes before game start", async () => {
  const game = GameInstance.getInstance();
  const originalStartTime = game.startTime;
  const originalSchedule = Scheduler.schedule;
  const manager = new MapVoteManager([AnniMap.AFTERMATH1V1]);
  manager.pollMessage = {} as any;

  let scheduledAt: Date | undefined;
  (Scheduler as any).schedule = (
    id: string,
    _callback: () => Promise<void>,
    targetTime: Date
  ) => {
    assertEqual(id, "mapVote", "Should use the map-vote scheduler task");
    scheduledAt = targetTime;
  };

  try {
    const startTime = new Date(Date.now() + 60 * 60 * 1000);
    game.startTime = startTime;

    await manager.rescheduleFinalization();

    assert(!!scheduledAt, "Should schedule map-vote finalization");
    assertEqual(
      scheduledAt!.getTime(),
      startTime.getTime() - 10 * 60 * 1000,
      "Map vote should finalize ten minutes before game start"
    );

    const editedStartTime = new Date(startTime.getTime() + 30 * 60 * 1000);
    game.startTime = editedStartTime;
    await manager.rescheduleFinalization();

    assertEqual(
      scheduledAt!.getTime(),
      editedStartTime.getTime() - 10 * 60 * 1000,
      "Rescheduling should use the edited game start time"
    );
  } finally {
    game.startTime = originalStartTime;
    (Scheduler as any).schedule = originalSchedule;
  }
});

test("map vote finalizes immediately inside the ten-minute window", async () => {
  const game = GameInstance.getInstance();
  const originalStartTime = game.startTime;
  const originalCancel = Scheduler.cancel;
  const manager = new MapVoteManager([AnniMap.AFTERMATH1V1]);
  manager.pollMessage = {} as any;

  let canceledTask: string | undefined;
  let finalizeCalls = 0;
  (Scheduler as any).cancel = (id: string) => {
    canceledTask = id;
  };
  (manager as any).finalizeVotes = async () => {
    finalizeCalls += 1;
  };

  try {
    game.startTime = new Date(Date.now() + 5 * 60 * 1000);
    await manager.rescheduleFinalization();

    assertEqual(canceledTask, "mapVote", "Should cancel any stale schedule");
    assertEqual(finalizeCalls, 1, "Should immediately finalize the map vote");
  } finally {
    game.startTime = originalStartTime;
    (Scheduler as any).cancel = originalCancel;
  }
});
