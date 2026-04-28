import { test } from "../framework/test";
import { assert } from "../framework/assert";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import GameCommand from "../../src/commands/GameCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { prismaClient } from "../../src/database/prismaClient";

test("GameCommand /game start marks 16-player games as no elo and announces it", async () => {
  const originalAuth = PermissionsUtil.isUserAuthorised;
  const originalSend = DiscordUtil.sendMessage;
  const originalMove = (DiscordUtil as any).moveToVC;
  const originalAssign = (DiscordUtil as any).assignRole;

  const guild = new FakeGuild() as any;
  const game = CurrentGameManager.getCurrentGame();
  game.reset();

  for (let i = 1; i <= 16; i++) {
    const member = new FakeGuildMember(`p${i}`);
    guild.addMember(member);
    const player = {
      discordSnowflake: member.id,
      ignUsed: `Player_${i}`,
      elo: 1000,
      captain: false,
      playerId: `db-${member.id}`,
    };
    if (i <= 8) {
      game.teams.RED.push(player as any);
    } else {
      game.teams.BLUE.push(player as any);
    }
  }

  const sent: Array<{ channel: string; content: any }> = [];

  (PermissionsUtil as any).isUserAuthorised = async () => true;
  (DiscordUtil as any).sendMessage = async (channel: string, content: any) => {
    sent.push({ channel, content });
  };
  (DiscordUtil as any).moveToVC = async () => {};
  (DiscordUtil as any).assignRole = async () => {};

  try {
    const cmd = new GameCommand();
    const interaction = createChatInputInteraction("organiser", {
      guild,
      subcommand: "start",
    }) as any;

    await cmd.execute(interaction);

    assert(game.noElo === true, "Expected low-player game to be marked noElo");
    assert(
      sent.some(
        (m) =>
          m.channel === "gameFeed" &&
          String(m.content).includes("no elo game") &&
          String(m.content).includes("16 players")
      ),
      "Expected no-elo notice in game feed"
    );
    assert(
      sent.some(
        (m) =>
          m.channel === "redTeamChat" &&
          String(m.content).includes("no elo game")
      ),
      "Expected no-elo notice in red team chat"
    );
    assert(
      sent.some(
        (m) =>
          m.channel === "blueTeamChat" &&
          String(m.content).includes("no elo game")
      ),
      "Expected no-elo notice in blue team chat"
    );
  } finally {
    (PermissionsUtil as any).isUserAuthorised = originalAuth;
    (DiscordUtil as any).sendMessage = originalSend;
    (DiscordUtil as any).moveToVC = originalMove;
    (DiscordUtil as any).assignRole = originalAssign;
    game.reset();
  }
});

test("GameCommand /game start does not mark 20-player games as no elo", async () => {
  const originalAuth = PermissionsUtil.isUserAuthorised;
  const originalSend = DiscordUtil.sendMessage;
  const originalMove = (DiscordUtil as any).moveToVC;
  const originalAssign = (DiscordUtil as any).assignRole;

  const guild = new FakeGuild() as any;
  const game = CurrentGameManager.getCurrentGame();
  game.reset();

  for (let i = 1; i <= 20; i++) {
    const member = new FakeGuildMember(`p${i}`);
    guild.addMember(member);
    const player = {
      discordSnowflake: member.id,
      ignUsed: `Player_${i}`,
      elo: 1000,
      captain: false,
      playerId: `db-${member.id}`,
    };
    if (i <= 10) {
      game.teams.RED.push(player as any);
    } else {
      game.teams.BLUE.push(player as any);
    }
  }

  const sent: Array<{ channel: string; content: any }> = [];

  (PermissionsUtil as any).isUserAuthorised = async () => true;
  (DiscordUtil as any).sendMessage = async (channel: string, content: any) => {
    sent.push({ channel, content });
  };
  (DiscordUtil as any).moveToVC = async () => {};
  (DiscordUtil as any).assignRole = async () => {};

  try {
    const cmd = new GameCommand();
    const interaction = createChatInputInteraction("organiser", {
      guild,
      subcommand: "start",
    }) as any;

    await cmd.execute(interaction);

    assert(
      game.noElo === false,
      "Expected 20-player game to remain Elo-enabled"
    );
    assert(
      !sent.some((m) => String(m.content).includes("no elo game")),
      "Should not send a no-elo notice at the minimum threshold"
    );
  } finally {
    (PermissionsUtil as any).isUserAuthorised = originalAuth;
    (DiscordUtil as any).sendMessage = originalSend;
    (DiscordUtil as any).moveToVC = originalMove;
    (DiscordUtil as any).assignRole = originalAssign;
    game.reset();
  }
});

test("saveGameFromInstance skips elo writes and elo history for no-elo games", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.noElo = true;
  game.gameWinner = "RED";
  game.organiser = "Org";
  game.host = "Host";
  game.startTime = new Date("2026-04-22T19:00:00Z");
  game.endTime = new Date("2026-04-22T20:00:00Z");

  game.teams.RED.push({
    discordSnowflake: "red1",
    ignUsed: "Red_One",
    elo: 1000,
    captain: true,
    playerId: "db-red1",
    wins: 0,
    losses: 0,
    winStreak: 0,
    loseStreak: 0,
    biggestWinStreak: 0,
    biggestLosingStreak: 0,
  } as any);
  game.teams.BLUE.push({
    discordSnowflake: "blue1",
    ignUsed: "Blue_One",
    elo: 1000,
    captain: false,
    playerId: "db-blue1",
    wins: 0,
    losses: 0,
    winStreak: 0,
    loseStreak: 0,
    biggestWinStreak: 0,
    biggestLosingStreak: 0,
  } as any);

  const originalSeason = (prismaClient as any).season;
  const originalByDiscord = (prismaClient as any).player.byDiscordSnowflake;
  const originalGetStats = (prismaClient as any).player
    .getPlayerStatsForCurrentSeason;
  const originalPlayerStats = (prismaClient as any).playerStats;
  const originalGame = (prismaClient as any).game;
  const originalEloHistory = (prismaClient as any).eloHistory;

  let eloValueUpdates = 0;
  let eloHistoryCreates = 0;

  (prismaClient as any).season = {
    findFirst: async () => ({ id: "season1", number: 1, isActive: true }),
    findUnique: async () => ({ id: "season1", number: 1 }),
  };
  (prismaClient as any).player.byDiscordSnowflake = async (id: string) => ({
    id: `db-${id}`,
    discordSnowflake: id,
  });
  (prismaClient as any).player.getPlayerStatsForCurrentSeason = async () => ({
    seasonId: "season1",
    wins: 0,
    losses: 0,
    winStreak: 0,
    loseStreak: 0,
    biggestWinStreak: 0,
    biggestLosingStreak: 0,
    elo: 1000,
  });
  (prismaClient as any).playerStats = {
    update: async ({ data }: any) => {
      if (Object.prototype.hasOwnProperty.call(data, "elo")) {
        eloValueUpdates += 1;
      }
      return { data };
    },
  };
  (prismaClient as any).eloHistory = {
    create: async () => {
      eloHistoryCreates += 1;
      return {};
    },
  };
  (prismaClient as any).game = {
    ...originalGame,
    upsert: async () => ({ id: "game1", gameParticipations: [] }),
    saveGameFromInstance: originalGame.saveGameFromInstance,
  };

  try {
    await (prismaClient as any).game.saveGameFromInstance(game);

    assert(
      eloValueUpdates === 0,
      "Expected no Elo stat writes for no-elo games"
    );
    assert(
      eloHistoryCreates === 0,
      "Expected no Elo history records for no-elo games"
    );
  } finally {
    (prismaClient as any).season = originalSeason;
    (prismaClient as any).player.byDiscordSnowflake = originalByDiscord;
    (prismaClient as any).player.getPlayerStatsForCurrentSeason =
      originalGetStats;
    (prismaClient as any).playerStats = originalPlayerStats;
    (prismaClient as any).game = originalGame;
    (prismaClient as any).eloHistory = originalEloHistory;
    game.reset();
  }
});
