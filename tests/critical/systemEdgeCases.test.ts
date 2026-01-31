import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import WinnerCommand from "../../src/commands/WinnerCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { Channels } from "../../src/Channels";
import { GameInstance } from "../../src/database/GameInstance";

test("Winner confirmation rejects other users", async () => {
  const cmd = new WinnerCommand();
  const originalAuth = PermissionsUtil.isUserAuthorised;
  const originalGet = CurrentGameManager.getCurrentGame;
  let setCalled = false;

  const game = {
    getCaptainOfTeam: (_team: string) => null,
    getPlayersOfTeam: (_team: string) => [],
    setGameWinner: async (_team: string) => {
      setCalled = true;
    },
  };

  (PermissionsUtil as any).isUserAuthorised = async () => true;
  (CurrentGameManager as any).getCurrentGame = () => game;

  const interaction: any = {
    user: { id: "u1" },
    options: { getString: () => "RED" },
    reply: async () => {},
    fetchReply: async () => ({ id: "msg-1" }),
  };

  const replies: any[] = [];
  const buttonInteraction: any = {
    customId: "winner_confirm_yes",
    message: { id: "msg-1" },
    user: { id: "u2" },
    update: async (_payload: any) => {},
    reply: async (payload: any) => {
      replies.push(payload);
    },
  };

  try {
    await cmd.execute(interaction as any);
    await cmd.handleButtonPress!(buttonInteraction as any);
    assert(!setCalled, "Winner should not be set by a different user");
    assert(
      replies.some((r) => /only the user/i.test(String(r.content))),
      "Should warn about unauthorized confirmation"
    );
  } finally {
    (PermissionsUtil as any).isUserAuthorised = originalAuth;
    (CurrentGameManager as any).getCurrentGame = originalGet;
  }
});

test("Winner confirmation expires for unknown message id", async () => {
  const cmd = new WinnerCommand();
  const replies: any[] = [];
  const buttonInteraction: any = {
    customId: "winner_confirm_yes",
    message: { id: "missing-msg" },
    user: { id: "u1" },
    update: async (_payload: any) => {},
    reply: async (payload: any) => {
      replies.push(payload);
    },
  };

  await cmd.handleButtonPress!(buttonInteraction as any);
  assert(
    replies.some((r) => /expired/i.test(String(r.content))),
    "Should report expired confirmation"
  );
});

test("Auto-balance removal avoids captains", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  const redCap = { discordSnowflake: "R", captain: true } as any;
  const blueCap = { discordSnowflake: "B", captain: true } as any;
  (game as any).teams = {
    RED: [redCap],
    BLUE: [blueCap],
    UNDECIDED: [{ discordSnowflake: "U1" }, { discordSnowflake: "U2" }],
  };
  game.lastRegisteredSnowflake = "R";

  const removalId = (CurrentGameManager as any).getAutoBalanceRemovalId(game);
  assert(removalId !== "R" && removalId !== "B", "Should not remove a captain");
  assert(removalId === "U2", "Should fall back to last undecided player");
});

test("Removing last registered player clears lastRegisteredSnowflake", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const player = { discordSnowflake: "U1" } as any;
  (game as any).teams = { RED: [], BLUE: [], UNDECIDED: [player] };
  game.lastRegisteredSnowflake = "U1";

  await game.removePlayerByDiscordId("U1");
  assertEqual(
    game.lastRegisteredSnowflake,
    undefined,
    "lastRegisteredSnowflake should be cleared"
  );
});

test("sendMessage handles missing channel without throwing", async () => {
  const originalRegistration = (Channels as any).registration;
  (Channels as any).registration = undefined;
  try {
    await DiscordUtil.sendMessage("registration", "test");
    assert(true, "sendMessage should not throw");
  } finally {
    (Channels as any).registration = originalRegistration;
  }
});
