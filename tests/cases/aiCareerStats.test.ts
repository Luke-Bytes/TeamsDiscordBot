import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { prismaClient } from "../../src/database/prismaClient";
import {
  AiCaller,
  AiToolDenied,
  executeAiTool,
  permittedAiTools,
} from "../../src/ai/AiTools";
import { autoReadsForAsk } from "../../src/ai/AiAutoReads";
import { needsVerifiedServerData } from "../../src/ai/AiAssistant";

const caller: AiCaller = {
  guildId: "offline-fw",
  discordUserId: "trusted-member",
  verifyMembership: async () => ({ member: true, organiser: false }),
};

test("Lifetime questions offer and automatically select safe career tools", async () => {
  for (const [question, tool] of [
    ["what are my all time stats", "get_my_all_time_stats"],
    ["how many MVPs have I won ever", "get_my_all_time_stats"],
    ["career stats for Backmobe", "get_player_all_time_stats"],
    [
      "How many MVPs has Backmobe earned all time?",
      "get_player_all_time_stats",
    ],
    ["analyse the stats of Backmobe", "get_player_all_time_stats"],
  ]) {
    assert(
      autoReadsForAsk(question).some((entry) => entry.name === tool),
      "Missing lifetime read: " + question
    );
  }
  assert(
    !autoReadsForAsk("analyse the stats of Backmobe in season 14").some(
      (entry) => entry.name === "get_player_all_time_stats"
    ),
    "Explicit single-season request must not pull a lifetime summary"
  );
  assert(
    autoReadsForAsk("who is best player of all time")[0]?.name ===
      "get_all_time_leaderboard",
    "Best-player prompt uses metric-qualified leaderboard instead of guessing one person's stats"
  );
  assert(
    needsVerifiedServerData("what are my career stats?") &&
      permittedAiTools(false, false).some(
        (tool) => tool.function.name === "get_my_all_time_stats"
      ),
    "Lifetime claims need real data, and regular members may see the approved read"
  );
});

test("Career tools reuse saved seasonal totals and completed-match achievements without leaking IDs", async () => {
  const oldSelf = prismaClient.player.findUnique;
  const oldNamed = prismaClient.player.findMany;
  const oldAggregate = prismaClient.playerStats.aggregate;
  const oldTop = prismaClient.playerStats.findFirst;
  const oldCount = prismaClient.gameParticipation.count;
  const oldLast = prismaClient.gameParticipation.findFirst;
  const seen: any[] = [];
  try {
    (prismaClient.player as any).findUnique = async (args: any) => {
      assert(
        args.where.discordSnowflake === "trusted-member",
        "Self lookup cannot impersonate another Discord member"
      );
      return { id: "internal-player-id", latestIGN: "Backmobe" };
    };
    (prismaClient.player as any).findMany = async (args: any) => {
      assert(
        args.where.latestIGN.equals === "backmobe" &&
          args.where.latestIGN.mode === "insensitive" &&
          args.take === 2 &&
          !args.select.discordSnowflake,
        "Named lookup is exact, case-insensitive, bounded, and omits Discord identity"
      );
      return [{ id: "internal-player-id", latestIGN: "Backmobe" }];
    };
    (prismaClient.playerStats as any).aggregate = async (args: any) => {
      assert(
        args.where.playerId === "internal-player-id" && args._count._all,
        "Use DB-side lifetime aggregate"
      );
      return {
        _sum: { wins: 42, losses: 18 },
        _max: { biggestWinStreak: 6, biggestLosingStreak: 3 },
        _count: { _all: 5 },
      };
    };
    (prismaClient.gameParticipation as any).count = async (args: any) => {
      seen.push(args.where);
      assert(
        args.where.playerId === "internal-player-id",
        "Counts are player-scoped"
      );
      if (args.where.mvp) return 8;
      if (args.where.captain && args.where.OR) return 9;
      if (args.where.captain) return 15;
      if (args.where.OR) return 4;
      return -1;
    };
    (prismaClient.playerStats as any).findFirst = async (args: any) => {
      assert(
        args.where.season.is.OR.some((row: any) => row.type === "RANKED"),
        "Exclude Relaxed Elo from best saved season rating"
      );
      return { elo: 1314, season: { number: 9 } };
    };
    (prismaClient.gameParticipation as any).findFirst = async (args: any) => {
      assert(
        args.where.game.is.finished === true,
        "Only recorded finished games count as last played"
      );
      return { game: { endTime: new Date("2026-07-11T12:00:00Z") } };
    };

    for (const [name, input] of [
      ["get_my_all_time_stats", "{}"],
      ["get_player_all_time_stats", '{"ign":"backmobe"}'],
    ]) {
      const result: any = await executeAiTool(name, input, caller);
      assert(
        result.status === "ok" &&
          result.player === "Backmobe" &&
          result.gamesPlayed === 60 &&
          result.wins === 42 &&
          result.losses === 18 &&
          result.winRatePercent === 70 &&
          result.mvps === 8 &&
          result.captainGames === 15 &&
          result.captainWins === 9 &&
          result.captainWinRatePercent === 60 &&
          result.doubleEloWins === 4 &&
          result.bestSingleSeasonWinStreak === 6 &&
          result.highestSavedRankedSeasonElo.elo === 1314 &&
          result.mostRecentFinishedGameAt === "2026-07-11T12:00:00.000Z" &&
          !JSON.stringify(result).includes("internal-player-id"),
        "Exact career projection is public, season-aware and identity-safe"
      );
    }
    assert(
      seen.length === 8,
      "Four detailed season-metric-equivalent reads per career query"
    );
    assert(
      seen.every((w) => !!w.OR || w.game?.is?.finished === true),
      "All achievements require a saved finished match"
    );
  } finally {
    prismaClient.player.findUnique = oldSelf;
    prismaClient.player.findMany = oldNamed;
    prismaClient.playerStats.aggregate = oldAggregate;
    prismaClient.playerStats.findFirst = oldTop;
    prismaClient.gameParticipation.count = oldCount;
    prismaClient.gameParticipation.findFirst = oldLast;
  }
});

test("Lifetime reads fail closed on malformed or impersonating inputs", async () => {
  for (const [name, raw] of [
    ["get_my_all_time_stats", '{"ign":"Other"}'],
    ["get_my_all_time_stats", '{"season":2}'],
    ["get_player_all_time_stats", '{"ign":{"contains":"B"}}'],
    ["get_player_all_time_stats", '{"ign":"B"}'],
    ["get_player_all_time_stats", '{"ign":"Backmobe","discordUserId":"other"}'],
  ]) {
    try {
      await executeAiTool(name, raw, caller);
      assert(false, "Denied unsafe career tool call " + name);
    } catch (error) {
      assert(
        error instanceof AiToolDenied,
        "Typed validation denies before DB read"
      );
    }
  }
  try {
    await executeAiTool("get_my_all_time_stats", "{}", {
      ...caller,
      verifyMembership: async () => ({ member: false, organiser: true }),
    });
    assert(false, "Lost Discord membership must deny career tool");
  } catch (error) {
    assert(error instanceof AiToolDenied, "Verified membership required");
  }
});
