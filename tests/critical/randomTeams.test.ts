import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { RandomTeamPickingSession } from "../../src/logic/teams/RandomTeamPickingSession";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { Channels } from "../../src/Channels";

function mkPlayer(id: string, ign: string) {
  return { discordSnowflake: id, ignUsed: ign, elo: 1000 } as any;
}

test("Random teams accept uses the previewed teams", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  const p1 = mkPlayer("p1", "One");
  const p2 = mkPlayer("p2", "Two");
  const p3 = mkPlayer("p3", "Three");
  const p4 = mkPlayer("p4", "Four");
  (game as any).teams = {
    RED: [],
    BLUE: [],
    UNDECIDED: [p1, p2, p3, p4],
  };

  const session = new RandomTeamPickingSession();
  let simulateCount = 0;
  const origSimulate = game.simulateShuffledTeams.bind(game);
  (game as any).simulateShuffledTeams = () => {
    simulateCount += 1;
    return simulateCount === 1
      ? { BLUE: [p1, p2], RED: [p3, p4] }
      : { BLUE: [p3, p4], RED: [p1, p2] };
  };

  const interaction: any = {
    deferred: true,
    replied: false,
    deferReply: async () => {},
    editReply: async (_payload: any) => ({
      edit: async () => {},
    }),
  };

  const button: any = {
    customId: "random-team-accept",
    update: async () => {},
  };

  const originalChannel = Channels.teamPicking;
  Channels.teamPicking = {
    id: "team-pick",
    isSendable: () => true,
    send: async () => ({ edit: async () => {} }),
    messages: { fetch: async () => ({ find: () => undefined }) },
  } as any;

  try {
    await session.initialize(interaction as any);
    await session.handleInteraction(button as any);
    assert(
      game.getPlayersOfTeam("BLUE").some((p: any) => p.discordSnowflake === "p1"),
      "Should commit previewed BLUE team"
    );
    assert(
      game.getPlayersOfTeam("RED").some((p: any) => p.discordSnowflake === "p3"),
      "Should commit previewed RED team"
    );
  } finally {
    (game as any).simulateShuffledTeams = origSimulate;
    Channels.teamPicking = originalChannel;
  }
});

test("Random team reroll updates the previewed teams used on accept", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  const p1 = mkPlayer("p1", "One");
  const p2 = mkPlayer("p2", "Two");
  const p3 = mkPlayer("p3", "Three");
  const p4 = mkPlayer("p4", "Four");
  (game as any).teams = {
    RED: [],
    BLUE: [],
    UNDECIDED: [p1, p2, p3, p4],
  };

  const session = new RandomTeamPickingSession();
  let simulateCount = 0;
  const origSimulate = game.simulateShuffledTeams.bind(game);
  (game as any).simulateShuffledTeams = () => {
    simulateCount += 1;
    return simulateCount === 1
      ? { BLUE: [p1, p2], RED: [p3, p4] }
      : { BLUE: [p3, p4], RED: [p1, p2] };
  };

  const interaction: any = {
    deferred: true,
    replied: false,
    deferReply: async () => {},
    editReply: async (_payload: any) => ({
      edit: async () => {},
    }),
  };

  const rerollButton: any = {
    customId: "random-team-generate-reroll",
    update: async () => {},
  };
  const acceptButton: any = {
    customId: "random-team-accept",
    update: async () => {},
  };

  const originalChannel = Channels.teamPicking;
  Channels.teamPicking = {
    id: "team-pick",
    isSendable: () => true,
    send: async () => ({ edit: async () => {} }),
    messages: { fetch: async () => ({ find: () => undefined }) },
  } as any;

  try {
    await session.initialize(interaction as any);
    await session.handleInteraction(rerollButton as any);
    await session.handleInteraction(acceptButton as any);
    assert(
      game.getPlayersOfTeam("BLUE").some((p: any) => p.discordSnowflake === "p3"),
      "Accept should use the rerolled BLUE team"
    );
    assert(
      game.getPlayersOfTeam("RED").some((p: any) => p.discordSnowflake === "p1"),
      "Accept should use the rerolled RED team"
    );
  } finally {
    (game as any).simulateShuffledTeams = origSimulate;
    Channels.teamPicking = originalChannel;
  }
});
