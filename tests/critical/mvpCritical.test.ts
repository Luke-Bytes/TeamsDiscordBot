import { test } from "../framework/test";
import { assert } from "../framework/assert";
import MVPCommand from "../../src/commands/MVPCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { createChatInputInteraction } from "../framework/mocks";
import { ConfigManager } from "../../src/ConfigManager";

test("MVP cannot vote before game finished", async () => {
  const cmd = new MVPCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.isFinished = false;
  const cfg = ConfigManager.getConfig();
  const voter = {
    discordSnowflake: "V1",
    ignUsed: "Voter",
    captain: false,
  } as any;
  (game as any).teams = { RED: [voter], BLUE: [], UNDECIDED: [] };
  const i = createChatInputInteraction("V1", {
    channelId: cfg.channels.redTeamChat,
    subcommand: "vote",
    strings: { player: "X" },
  });
  await cmd.execute(i);
  const reply = i.replies.find((r) => r.type === "reply");
  assert(
    !!reply && /not finished/.test(String(reply.payload?.content)),
    "Blocks MVP voting before game finished"
  );
});

test("MVP voting validations (channel, same team, not captain, not self)", async () => {
  const cmd = new MVPCommand();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.isFinished = true;
  const cfg = ConfigManager.getConfig();
  const voter = {
    discordSnowflake: "V1",
    ignUsed: "Voter",
    captain: false,
  } as any;
  const redCap = {
    discordSnowflake: "RC1",
    ignUsed: "RedCap",
    captain: true,
  } as any;
  const redMate = {
    discordSnowflake: "R2",
    ignUsed: "RedMate",
    captain: false,
  } as any;
  const blueMate = {
    discordSnowflake: "B2",
    ignUsed: "BlueMate",
    captain: false,
  } as any;
  (game as any).teams = {
    RED: [voter, redCap, redMate],
    BLUE: [blueMate],
    UNDECIDED: [],
  };

  // Wrong channel
  let i = createChatInputInteraction("V1", {
    channelId: "some-other",
    subcommand: "vote",
    strings: { player: "RedMate" },
  });
  await cmd.execute(i);
  let reply = i.replies.find((r) => r.type === "reply");
  assert(
    !!reply &&
      /must use this command in your team's/.test(
        String(reply.payload?.content)
      ),
    "Requires team channel"
  );

  // Correct channel, but vote for captain
  i = createChatInputInteraction("V1", {
    channelId: cfg.channels.redTeamChat,
    subcommand: "vote",
    strings: { player: "RedCap" },
  });
  await cmd.execute(i);
  reply = i.replies.find((r) => r.type === "reply");
  assert(
    !!reply &&
      /cannot vote for a team captain/i.test(String(reply.payload?.content)),
    "Blocks captain votes"
  );

  // Self vote
  i = createChatInputInteraction("V1", {
    channelId: cfg.channels.redTeamChat,
    subcommand: "vote",
    strings: { player: "Voter" },
  });
  await cmd.execute(i);
  reply = i.replies.find((r) => r.type === "reply");
  assert(
    !!reply && /cannot vote for yourself/i.test(String(reply.payload?.content)),
    "Blocks self votes"
  );

  // Cross-team vote
  i = createChatInputInteraction("V1", {
    channelId: cfg.channels.redTeamChat,
    subcommand: "vote",
    strings: { player: "BlueMate" },
  });
  await cmd.execute(i);
  reply = i.replies.find((r) => r.type === "reply");
  assert(
    !!reply &&
      /only vote for players on your own team/i.test(
        String(reply.payload?.content)
      ),
    "Blocks cross-team votes"
  );

  // Success
  i = createChatInputInteraction("V1", {
    channelId: cfg.channels.redTeamChat,
    subcommand: "vote",
    strings: { player: "RedMate" },
  });
  await cmd.execute(i);
  reply = i.replies.find((r) => r.type === "reply");
  assert(
    !!reply && /has been recorded/i.test(String(reply.payload?.content)),
    "Records valid MVP vote"
  );
  assert(
    /\+1\s*Elo/i.test(String(reply.payload?.content)),
    "Success message mentions +1 Elo reward"
  );
});

test("Voting MVP grants +1 Elo at Elo calculation time", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.isFinished = true;
  game.gameWinner = "RED";

  const voter = {
    discordSnowflake: "V100",
    ignUsed: "Voter",
    captain: false,
    elo: 1000,
    winStreak: 0,
  } as any;
  const target = {
    discordSnowflake: "T100",
    ignUsed: "Target",
    captain: false,
    elo: 1000,
    winStreak: 0,
  } as any;
  (game as any).teams = { RED: [voter, target], BLUE: [], UNDECIDED: [] };
  game.calculateMeanEloAndExpectedScore();

  const { Elo } = await import("../../src/logic/Elo");
  const elo = new Elo();

  const beforeVote = elo.calculateNewElo(voter);
  game.voteMvp("V100", "T100");
  const afterVote = elo.calculateNewElo(voter);

  assert(
    afterVote - beforeVote === 1,
    `Expected +1 Elo, got ${afterVote - beforeVote}`
  );
});
