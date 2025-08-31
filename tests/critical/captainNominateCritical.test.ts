import { test } from "../framework/test";
import { assert } from "../framework/assert";
import CaptainNominateCommand from "../../src/commands/CaptainNominate";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { createChatInputInteraction } from "../framework/mocks";

test("CaptainNominate rejects when no game announced", async () => {
  const cmd = new CaptainNominateCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = false;
  const i = createChatInputInteraction("U1");
  await cmd.execute(i);
  const reply = i.replies.find((r) => r.type === "reply");
  assert(
    !!reply &&
      /No game has been announced/.test(String(reply.payload?.content)),
    "Rejects before announcement"
  );
});

test("CaptainNominate requires registration and blocks duplicates", async () => {
  const cmd = new CaptainNominateCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  (game as any).teams = { RED: [], BLUE: [], UNDECIDED: [] };
  const sent: any[] = [];
  const DiscordUtil = await import("../../src/util/DiscordUtil");
  const origSend =
    (DiscordUtil as any).DiscordUtil?.sendMessage ||
    (DiscordUtil as any).sendMessage;
  if ((DiscordUtil as any).DiscordUtil)
    (DiscordUtil as any).DiscordUtil.sendMessage = async (ch: string, c: any) =>
      sent.push({ ch, c });
  else
    (DiscordUtil as any).sendMessage = async (ch: string, c: any) =>
      sent.push({ ch, c });

  let i = createChatInputInteraction("U2");
  await cmd.execute(i);
  let reply = i.replies.find((r) => r.type === "reply");
  assert(!!reply, "Should reply when not registered");
  assert(
    !sent.some((s) => /has nominated/.test(String(s.c || s.content))),
    "Should not announce to gameFeed on invalid nomination"
  );

  // Register U3 and attempt nominate twice
  (game as any).teams = {
    RED: [],
    BLUE: [],
    UNDECIDED: [{ discordSnowflake: "U3", ignUsed: "X" }],
  };
  i = createChatInputInteraction("U3");
  await cmd.execute(i);
  const iAgain = createChatInputInteraction("U3");
  await cmd.execute(iAgain);
  reply = iAgain.replies.find((r) => r.type === "reply");
  assert(!!reply, "Blocks duplicate nominations");
  // restore
  if ((DiscordUtil as any).DiscordUtil)
    (DiscordUtil as any).DiscordUtil.sendMessage = origSend;
  else (DiscordUtil as any).sendMessage = origSend;
});
