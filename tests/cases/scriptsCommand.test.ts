import { test } from "../framework/test";
import { assert } from "../framework/assert";
import ScriptsCommand from "../../src/commands/ScriptsCommand";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { ConfigManager } from "../../src/ConfigManager";
import { prismaClient } from "../../src/database/prismaClient";
import { TitleStore } from "../../src/util/TitleStore";

test("/scripts titles-update awards earned titles", async () => {
  const cmd = new ScriptsCommand();
  const cfg = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;
  const organiser = new FakeGuildMember("ORG");
  await organiser.roles.add(cfg.roles.organiserRole);
  guild.addMember(organiser);

  TitleStore.setOverride([
    { id: "CHAMPION", label: "Champion" },
    { id: "PARAGON", label: "Paragon" },
  ]);

  const orig = {
    playerStats: (prismaClient as any).playerStats,
    gameParticipation: (prismaClient as any).gameParticipation,
    season: (prismaClient as any).season,
    player: (prismaClient as any).player,
    game: (prismaClient as any).game,
    profile: (prismaClient as any).profile,
  };

  const updated: Record<string, string[]> = {};
  try {
    (prismaClient as any).season = {
      findMany: async () => [{ id: "S1", number: 1 }],
    };
    (prismaClient as any).playerStats = {
      findMany: async () => [
        {
          playerId: "P1",
          seasonId: "S1",
          elo: 1500,
          wins: 10,
          losses: 0,
          player: { id: "P1", latestIGN: "Alpha" },
        },
      ],
    };
    (prismaClient as any).gameParticipation = {
      findMany: async (_args: any) => [
        {
          playerId: "P1",
          mvp: true,
          captain: false,
          team: "RED",
          game: { winner: "RED" },
        },
        {
          playerId: "P1",
          mvp: true,
          captain: false,
          team: "RED",
          game: { winner: "RED" },
        },
        {
          playerId: "P1",
          mvp: true,
          captain: false,
          team: "RED",
          game: { winner: "RED" },
        },
        {
          playerId: "P1",
          mvp: true,
          captain: false,
          team: "RED",
          game: { winner: "RED" },
        },
        {
          playerId: "P1",
          mvp: true,
          captain: false,
          team: "RED",
          game: { winner: "RED" },
        },
        {
          playerId: "P1",
          mvp: true,
          captain: false,
          team: "RED",
          game: { winner: "RED" },
        },
        {
          playerId: "P1",
          mvp: true,
          captain: false,
          team: "RED",
          game: { winner: "RED" },
        },
        {
          playerId: "P1",
          mvp: true,
          captain: false,
          team: "RED",
          game: { winner: "RED" },
        },
        {
          playerId: "P1",
          mvp: true,
          captain: false,
          team: "RED",
          game: { winner: "RED" },
        },
        {
          playerId: "P1",
          mvp: true,
          captain: false,
          team: "RED",
          game: { winner: "RED" },
        },
      ],
    };
    (prismaClient as any).player = {
      findMany: async () => [{ id: "P1", latestIGN: "Alpha" }],
    };
    (prismaClient as any).game = {
      findMany: async () => [],
    };
    (prismaClient as any).profile = {
      findUnique: async () => ({ unlockedTitles: [] }),
      upsert: async (args: any) => {
        updated[args.where.playerId] = args.update.unlockedTitles;
        return {};
      },
    };

    const i = createChatInputInteraction("ORG", {
      guild,
      member: organiser as any,
      subcommand: "titles-update",
    }) as any;
    i.inGuild = () => true;
    await cmd.execute(i);

    assert(updated.P1?.includes("CHAMPION"), "Champion awarded for #1 season");
    assert(updated.P1?.includes("PARAGON"), "Paragon awarded for 10 MVPs");
  } finally {
    (prismaClient as any).playerStats = orig.playerStats;
    (prismaClient as any).gameParticipation = orig.gameParticipation;
    (prismaClient as any).season = orig.season;
    (prismaClient as any).player = orig.player;
    (prismaClient as any).game = orig.game;
    (prismaClient as any).profile = orig.profile;
    TitleStore.clearOverride();
  }
});
