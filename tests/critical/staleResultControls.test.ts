import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { createChatInputInteraction } from "../framework/mocks";
import { GameInstance } from "../../src/database/GameInstance";
import WinnerCommand from "../../src/commands/WinnerCommand";
import ForfeitCommand from "../../src/commands/ForfeitCommand";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";

test("winner confirmation from a previous game cannot set the new game's result", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  const command = new WinnerCommand();
  const originalAuth = PermissionsUtil.isUserAuthorised;
  (PermissionsUtil as any).isUserAuthorised = async () => true;
  try {
    const interaction = createChatInputInteraction("12345", {
      subcommand: "set", strings: { team: "RED" },
    });
    await command.execute(interaction);
    const oldToken = game.getLifecycleToken();
    game.reset();
    game.announced = true;
    assert(oldToken !== game.getLifecycleToken(), "Reset must create a distinct game token");

    const replies: any[] = [];
    await command.handleButtonPress({
      user: { id: "12345" }, customId: "winner_confirm_yes",
      message: { id: "msg-1" },
      reply: async (payload: any) => replies.push(payload),
      update: async () => { throw new Error("Stale result must not update"); },
    } as any);
    assertEqual(game.gameWinner, undefined, "Old confirmation may not write a new game result");
    assert(replies.some((payload) => String(payload.content).includes("expired")),
      "Stale confirmation should be explicitly rejected");
  } finally {
    (PermissionsUtil as any).isUserAuthorised = originalAuth;
    game.reset();
  }
});

test("duplicate winner confirmations only commit once", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  const command = new WinnerCommand();
  const originalAuth = PermissionsUtil.isUserAuthorised;
  (PermissionsUtil as any).isUserAuthorised = async () => true;
  const originalSet = game.setGameWinner;
  let calls = 0;
  game.setGameWinner = async (team: any) => {
    calls += 1;
    await Promise.resolve();
    game.gameWinner = team;
  };
  try {
    await command.execute(createChatInputInteraction("12345", {
      subcommand: "set", strings: { team: "BLUE" },
    }));
    const replies: any[] = [];
    const makeButton = () => ({
      user: { id: "12345" }, customId: "winner_confirm_yes",
      message: { id: "msg-1" },
      reply: async (payload: any) => replies.push(payload),
      update: async () => {},
    });
    await Promise.all([
      command.handleButtonPress(makeButton() as any),
      command.handleButtonPress(makeButton() as any),
    ]);
    assertEqual(calls, 1, "Only one winner mutation can run");
    assertEqual(game.gameWinner, "BLUE", "Winner remains BLUE");
    assert(replies.some((payload) => String(payload.content).includes("expired")),
      "Repeated click should report expiration");
  } finally {
    game.setGameWinner = originalSet;
    (PermissionsUtil as any).isUserAuthorised = originalAuth;
    game.reset();
  }
});

test("forfeit button from another game cannot override the current winner", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  const token = game.getLifecycleToken();
  game.reset();
  game.announced = true;
  game.tryBeginGameStart();
  game.completeGameStart();
  game.gameWinner = "RED";
  const responses: any[] = [];
  const command = new ForfeitCommand();
  await command.handleButtonPress({
    user: { id: "98765" },
    customId: `forfeit_confirm:${token}`,
    message: { interaction: { user: { id: "98765" } } },
    reply: async (payload: any) => responses.push(payload),
  } as any);
  assertEqual(game.gameWinner, "RED", "Stale forfeit must not override result");
  assert(responses.some((payload) => String(payload.content).includes("expired")),
    "Stale forfeit should receive a meaningful response");
  game.reset();
});
