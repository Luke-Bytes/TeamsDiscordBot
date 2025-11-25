import { test } from "../framework/test";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { GameInstance } from "../../src/database/GameInstance";
import TeamCommand from "../../src/commands/TeamCommand";
import { gameFeed } from "../../src/logic/gameFeed/GameFeed";
import { prismaClient } from "../../src/database/prismaClient";

test("resetCurrentGame clears timers, sessions, votes, and state in-place", async () => {
  (prismaClient as any).game = (prismaClient as any).game || {};
  (prismaClient as any).game.saveGameFromInstance = async () => {};

  const teamCmd = new TeamCommand();
  (teamCmd as any).teamPickingSession = {
    state: "inProgress",
    getState() {
      return "inProgress" as const;
    },
  } as any;

  // Prepare a current game with set state and stub vote managers
  const pre = GameInstance.getInstance();
  pre.announced = true;
  pre.isFinished = false;
  let mapCanceled = false;
  let minerushCanceled = false;
  (pre as any).mapVoteManager = {
    cancelVote: () => {
      mapCanceled = true;
    },
  } as any;
  (pre as any).minerushVoteManager = {
    cancelVote: () => {
      minerushCanceled = true;
    },
  } as any;

  // Stub gameFeed removal to observe it being called
  let feedCleared = false;
  const originalRemoveAll = (gameFeed as any).removeAllFeedMessages;
  (gameFeed as any).removeAllFeedMessages = () => {
    feedCleared = true;
  };

  // Create some timers that should be cleared
  (CurrentGameManager as any).pollCloseTimeout = setTimeout(() => {}, 1000000);
  (CurrentGameManager as any).classBanWarningTimeout = setTimeout(
    () => {},
    1000000
  );
  (CurrentGameManager as any).classBanDeadlineTimeout = setTimeout(
    () => {},
    1000000
  );

  // Act: reset the game via manager
  CurrentGameManager.resetCurrentGame();

  // Assertions: same instance object, but state reset
  const post = GameInstance.getInstance();
  if (post !== pre)
    throw new Error("GameInstance reference changed (should reset in-place)");
  if (post.announced !== false) throw new Error("announced not reset to false");
  if (post.getPlayers().length !== 0) throw new Error("players not cleared");
  if (!mapCanceled) throw new Error("mapVoteManager.cancelVote was not called");
  if (!minerushCanceled)
    throw new Error("minerushVoteManager.cancelVote was not called");
  if (!feedCleared)
    throw new Error("gameFeed.removeAllFeedMessages was not called");
  if ((CurrentGameManager as any).pollCloseTimeout)
    throw new Error("pollCloseTimeout not cleared");
  if ((CurrentGameManager as any).classBanWarningTimeout)
    throw new Error("classBanWarningTimeout not cleared");
  if ((CurrentGameManager as any).classBanDeadlineTimeout)
    throw new Error("classBanDeadlineTimeout not cleared");
  if ((TeamCommand.instance as any).teamPickingSession)
    throw new Error("teamPickingSession not cleared");

  // Restore stubbed method
  (gameFeed as any).removeAllFeedMessages = originalRemoveAll;
});

test("resetGameInstance saves and resets in-place without stale references", async () => {
  // Stub prisma save to track it was called
  let saved = 0;
  (prismaClient as any).game = (prismaClient as any).game || {};
  (prismaClient as any).game.saveGameFromInstance = async () => {
    saved++;
  };

  const inst = GameInstance.getInstance();
  inst.announced = true;
  inst.isFinished = true;
  inst.settings.bannedClasses = ["ACROBAT" as any];

  const beforeRef = inst;
  await GameInstance.resetGameInstance();
  const afterRef = GameInstance.getInstance();

  if (saved !== 1)
    throw new Error("Expected game.saveGameFromInstance to be called once");
  if (afterRef !== beforeRef)
    throw new Error("GameInstance reference replaced (should reset in-place)");
  if (afterRef.announced)
    throw new Error("announced not cleared on in-place reset");
  if (afterRef.settings.bannedClasses.length !== 0)
    throw new Error("bannedClasses not cleared on in-place reset");
});
