import { SeasonType } from "@prisma/client";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { prismaClient } from "../../src/database/prismaClient";
import { SeasonService } from "../../src/database/SeasonService";
import {
  answerAiQuestion,
  needsVerifiedServerData,
} from "../../src/ai/AiAssistant";
import { autoReadsForAsk } from "../../src/ai/AiAutoReads";
import { AiCaller, AiToolDenied, executeAiTool } from "../../src/ai/AiTools";

const caller: AiCaller = {
  guildId: "offline-guild",
  discordUserId: "verified-caller",
  verifyMembership: async () => ({ member: true, organiser: false }),
};

test("Draft questions preload diverse metrics; explicit wins questions remain wins-only", () => {
  for (const question of [
    "Who's the best player of all time?",
    "If you were a captain who would you pick first?",
    "Who are the strongest FW players?",
    "Recommend players to draft for my team",
  ]) {
    assert(
      autoReadsForAsk(question)[0]?.name ===
        "get_player_performance_shortlist" && needsVerifiedServerData(question),
      "Subjective selection should get verified multi-metric evidence: " +
        question
    );
  }
  for (const question of [
    "Who has the most wins of all time?",
    "Top players by wins",
  ]) {
    assert(
      autoReadsForAsk(question)[0]?.name === "get_all_time_leaderboard",
      "Explicit wins queries retain their meaning: " + question
    );
  }
  const ranking = autoReadsForAsk(
    "Who are the top Ranked players in season 7?"
  );
  assert(
    ranking[0]?.name === "get_leaderboard" &&
      ranking[0].arguments === '{"limit":10,"season":7}' &&
      autoReadsForAsk("Top players this season")[0]?.name === "get_leaderboard",
    "Explicit Elo/season rankings still use the real standings tool"
  );
  const comparison = autoReadsForAsk(
    "Who should I pick for my team, Backmobe or AgentPanda_?"
  );
  assert(
    comparison.length === 4 &&
      comparison.map((r) => r.name).join(",") ===
        "get_player_all_time_stats,get_player_stats,get_player_all_time_stats,get_player_stats" &&
      comparison[0].arguments === '{"ign":"Backmobe"}' &&
      comparison[2].arguments === '{"ign":"AgentPanda_"}',
    "Two named alternatives preload both career and active-season stats"
  );
  assert(
    autoReadsForAsk("How do I start a game?").length === 0,
    "Timeless process help should not trigger a stats search"
  );
});

test("Multi-metric candidate snapshot is bounded, identity-safe and evidence-rich", async () => {
  const previous = {
    season: SeasonService.getActiveSeason,
    career: prismaClient.playerStats.groupBy,
    seasonStats: prismaClient.playerStats.findMany,
    achievements: prismaClient.gameParticipation.groupBy,
    players: prismaClient.player.findMany,
    identity: prismaClient.player.findUnique,
  };
  let relaxed = false;
  try {
    (SeasonService as any).getActiveSeason = async () => ({
      id: "internal-season",
      number: 7,
      type: relaxed ? SeasonType.RELAXED : SeasonType.RANKED,
    });
    (prismaClient.playerStats as any).groupBy = async (query: any) => {
      if (query.take === 4) {
        assert(
          query.orderBy._sum.wins === "desc",
          "Career-win candidates are ordered by wins"
        );
        return [
          { playerId: "internal-vet" },
          { playerId: "internal-balanced" },
        ];
      }
      assert(
        query.where.playerId.in.length === 3,
        "Career totals remain limited to candidates"
      );
      return [
        {
          playerId: "internal-vet",
          _sum: { wins: 60, losses: 40 },
          _max: { biggestWinStreak: 6 },
        },
        {
          playerId: "internal-balanced",
          _sum: { wins: 22, losses: 8 },
          _max: { biggestWinStreak: 4 },
        },
        {
          playerId: "internal-mvp",
          _sum: { wins: 8, losses: 2 },
          _max: { biggestWinStreak: 3 },
        },
      ];
    };
    (prismaClient.playerStats as any).findMany = async (query: any) => {
      if (query.where.OR) {
        assert(query.take === 4, "Season-leading candidates are bounded");
        return [{ playerId: "internal-balanced" }];
      }
      return [
        {
          playerId: "internal-vet",
          wins: 2,
          losses: 2,
          elo: 985,
          winStreak: 0,
        },
        {
          playerId: "internal-balanced",
          wins: 8,
          losses: 2,
          elo: 1170,
          winStreak: 3,
        },
        {
          playerId: "internal-mvp",
          wins: 1,
          losses: 0,
          elo: 1105,
          winStreak: 1,
        },
      ];
    };
    (prismaClient.gameParticipation as any).groupBy = async (query: any) => {
      assert(
        query.where.game?.is?.finished === true || !!query.where.OR,
        "Achievements require finished games"
      );
      if (query.take) {
        assert(
          query.take === 4 && query.where.mvp === true,
          "MVP candidates use a bounded independent cohort"
        );
        return [{ playerId: "internal-mvp", _count: { _all: 10 } }];
      }
      if (query.where.mvp)
        return [{ playerId: "internal-mvp", _count: { _all: 10 } }];
      if (query.where.OR)
        return [{ playerId: "internal-vet", _count: { _all: 5 } }];
      return [{ playerId: "internal-vet", _count: { _all: 7 } }];
    };
    (prismaClient.player as any).findMany = async (query: any) => {
      assert(
        query.select.latestIGN === true &&
          !query.select.discordSnowflake &&
          query.where.id.in.length === 3,
        "Only public candidate identity fields are selected"
      );
      return [
        { id: "internal-vet", latestIGN: "Veteran" },
        { id: "internal-balanced", latestIGN: "Balanced" },
        { id: "internal-mvp", latestIGN: "Impact" },
      ];
    };
    (prismaClient.player as any).findUnique = async () => null;

    const result: any = await executeAiTool(
      "get_player_performance_shortlist",
      "{}",
      caller
    );
    assert(
      result.status === "ok" &&
        result.season === 7 &&
        result.candidates.length === 3 &&
        result.candidates[0].career.winRatePercent === 60 &&
        result.candidates[0].career.captainGames === 7 &&
        result.candidates[0].career.captainWins === 5 &&
        result.candidates[1].currentSeason.elo === 1170 &&
        result.candidates[2].career.mvps === 10 &&
        result.candidates[2].selectedFor.includes("finished-game MVPs"),
      "Candidates cover career depth, recent-season Elo, win rate, MVP impact and captaincy"
    );
    const serialized = JSON.stringify(result);
    assert(
      serialized.length < 4000 &&
        !serialized.includes("internal-") &&
        !serialized.includes("discordSnowflake"),
      "The snapshot fits the provider budget and never exposes database/Discord IDs"
    );
    const answer = await answerAiQuestion({
      question: "Which FW players should I first pick?",
      organiser: false,
      caller,
      knowledge: [],
      infer: async (messages) => {
        assert(
          messages[2]?.content?.includes("get_player_performance_shortlist") &&
            messages[2]?.content?.includes("winRatePercent") &&
            messages[2]?.content?.includes("Impact"),
          "Performance evidence is added automatically to the very first model request"
        );
        return {
          content:
            "Balanced is promising based on current Elo and a 22–8 career record.",
          calls: [],
        };
      },
    });
    assert(
      answer.toolNames.includes("get_player_performance_shortlist") &&
        answer.text.includes("Balanced"),
      "An automatically verified shortlist supports a model response without extra tool rounds"
    );
    relaxed = true;
    const relaxedResult: any = await executeAiTool(
      "get_player_performance_shortlist",
      "{}",
      caller
    );
    assert(
      relaxedResult.seasonType === SeasonType.RELAXED &&
        relaxedResult.candidates.every(
          (entry: any) => entry.currentSeason?.elo === null
        ),
      "Relaxed activity must never be represented as Ranked Elo"
    );
  } finally {
    SeasonService.getActiveSeason = previous.season;
    prismaClient.playerStats.groupBy = previous.career;
    prismaClient.playerStats.findMany = previous.seasonStats;
    prismaClient.gameParticipation.groupBy = previous.achievements;
    prismaClient.player.findMany = previous.players;
    prismaClient.player.findUnique = previous.identity;
  }
});

test("Multi-metric tool blocks forged arguments or revoked guild membership", async () => {
  for (const args of ['{"limit":100}', '{"playerId":"someone"}']) {
    try {
      await executeAiTool("get_player_performance_shortlist", args, caller);
      assert(false, "Unexpected input should be rejected before a DB read");
    } catch (error) {
      assert(error instanceof AiToolDenied, "Reject client-controlled filters");
    }
  }
  try {
    await executeAiTool("get_player_performance_shortlist", "{}", {
      ...caller,
      verifyMembership: async () => ({ member: false, organiser: false }),
    });
    assert(false, "Revoked membership must deny reads");
  } catch (error) {
    assert(error instanceof AiToolDenied, "Caller membership is reverified");
  }
});
