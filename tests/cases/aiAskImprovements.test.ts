import { SeasonType } from "@prisma/client";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { prismaClient } from "../../src/database/prismaClient";
import { SeasonService } from "../../src/database/SeasonService";
import { answerAiQuestion } from "../../src/ai/AiAssistant";
import { autoReadsForAsk } from "../../src/ai/AiAutoReads";
import { AiCaller, executeAiTool } from "../../src/ai/AiTools";
import {
  buildApprovedKnowledge,
  retrieveApprovedKnowledge,
} from "../../src/ai/Knowledge";

const caller: AiCaller = {
  guildId: "fw-test-guild",
  discordUserId: "viewer",
  verifyMembership: async () => ({ member: true, organiser: true }),
};

test("Common logged /ask questions choose bounded read-only data automatically", () => {
  for (const [question, name] of [
    ["what commands are there", "get_command_catalog"],
    ["whos 5th on leaderboard right now", "get_leaderboard"],
    ["whos the best player of all time", "get_player_performance_shortlist"],
    ["name all the fw organiser", "list_organisers"],
    ["analyse the stats of Backmobe", "get_player_stats"],
    ["fun facts about fw", "get_season_summary"],
  ]) {
    assert(
      autoReadsForAsk(question).some((read) => read.name === name),
      "Missing automatic read: " + question
    );
  }
  assert(
    autoReadsForAsk("how do I play").length === 0 &&
      autoReadsForAsk("meow").length === 0 &&
      autoReadsForAsk("what scripts can you run").length === 0,
    "Simple instructions, chat and tool-safety questions do not trigger arbitrary DB reads"
  );
});

test("Verified organiser and linked IGN are available in initial context and simple self answers", async () => {
  const previous = prismaClient.player.findUnique;
  try {
    (prismaClient.player as any).findUnique = async (args: any) => {
      assert(
        args.where.discordSnowflake === "viewer" &&
          args.select.latestIGN === true &&
          Object.keys(args.select).length === 1,
        "The only identity query is bound to the verified Discord caller"
      );
      return { latestIGN: "ActualIGN" };
    };
    const simple = await answerAiQuestion({
      question: "WHO am i",
      organiser: true,
      caller,
      knowledge: [],
      infer: async () => {
        assert(false, "Self lookup should not spend a provider call");
        return { content: "never", calls: [] };
      },
    });
    assert(
      simple.text.includes("organiser") &&
        simple.text.includes("ActualIGN") &&
        simple.toolNames.length === 0,
      "Self response uses real role and latestIGN"
    );
    await answerAiQuestion({
      question: "How do I play?",
      organiser: true,
      caller,
      knowledge: buildApprovedKnowledge(process.cwd()),
      infer: async (messages) => {
        assert(
          messages[1].role === "system" &&
            messages[1].content.includes("organiser=true") &&
            messages[1].content.includes("ActualIGN") &&
            !JSON.stringify(messages).includes("discordSnowflake"),
          "Initial system context contains no hidden IDs"
        );
        return {
          content: "Use /register in the registration channel.",
          calls: [],
        };
      },
    });
  } finally {
    prismaClient.player.findUnique = previous;
  }
});

test("Automatic command and organiser reads carry trusted callback results, not guessed lists", async () => {
  const previous = prismaClient.player.findUnique;
  try {
    (prismaClient.player as any).findUnique = async () => null;
    for (const [question, expectedTool, detail] of [
      ["what commands are there", "get_command_catalog", "/register"],
      ["name all the fw organiser", "list_organisers", "ModExample"],
    ]) {
      const answer = await answerAiQuestion({
        question,
        organiser: false,
        caller: {
          ...caller,
          verifyMembership: async () => ({ member: true, organiser: false }),
          listCommands: async () => ({
            status: "ok",
            commands: ["/register: Sign up", "/help: Show commands"],
            total: 2,
            truncated: false,
          }),
          listOrganisers: async () => ({
            status: "ok",
            names: ["ModExample"],
            total: 1,
            truncated: false,
          }),
        },
        knowledge: [],
        infer: async (messages) => {
          assert(
            messages.some(
              (message) =>
                message.role === "user" &&
                message.content.includes("Fresh read-only") &&
                message.content.includes(detail)
            ),
            "Provider receives the actual scoped lookup as untrusted evidence"
          );
          return { content: "Answer based on the result.", calls: [] };
        },
      });
      assert(
        answer.toolNames.includes(expectedTool),
        "The automatic read counts as a real tool execution"
      );
    }
  } finally {
    prismaClient.player.findUnique = previous;
  }
});

test("All-time wins are aggregated across saved seasons with a bounded public projection", async () => {
  const previousGroup = prismaClient.playerStats.groupBy;
  const previousPlayers = prismaClient.player.findMany;
  let groupQuery: any;
  try {
    (prismaClient.playerStats as any).groupBy = async (query: any) => {
      groupQuery = query;
      return [
        { playerId: "id1", _sum: { wins: 30, losses: 12 } },
        { playerId: "id2", _sum: { wins: 20, losses: 6 } },
      ];
    };
    (prismaClient.player as any).findMany = async (query: any) => {
      assert(
        query.where.id.in.length === 2 &&
          query.select.latestIGN === true &&
          !query.select.discordSnowflake,
        "Only top-player public names are loaded"
      );
      return [
        { id: "id1", latestIGN: "Winner" },
        { id: "id2", latestIGN: "Runner" },
      ];
    };
    const result: any = await executeAiTool(
      "get_all_time_leaderboard",
      "{}",
      caller
    );
    assert(
      groupQuery.take === 10 &&
        groupQuery._sum.wins === true &&
        groupQuery.orderBy._sum.wins === "desc" &&
        result.entries[0].player === "Winner" &&
        result.entries[0].wins === 30 &&
        !JSON.stringify(result).includes("id1") &&
        result.caveat.includes("Relaxed"),
      "All-time answer remains bounded and metric-specific"
    );
  } finally {
    prismaClient.playerStats.groupBy = previousGroup;
    prismaClient.player.findMany = previousPlayers;
  }
});

test("A named player missing the active season still receives older saved-season context", async () => {
  const previousPlayer = prismaClient.player.findMany;
  const previousFind = prismaClient.playerStats.findUnique;
  const previousMany = prismaClient.playerStats.findMany;
  const previousSeason = SeasonService.getActiveSeason;
  try {
    (prismaClient.player as any).findMany = async () => [
      { id: "old-player", latestIGN: "Backmobe" },
    ];
    (prismaClient.playerStats as any).findUnique = async () => null;
    (prismaClient.playerStats as any).findMany = async (query: any) => {
      assert(query.take === 11, "Cross-season fallback is bounded");
      return [
        {
          wins: 5,
          losses: 3,
          elo: 1090,
          season: { number: 11, type: SeasonType.RANKED },
        },
      ];
    };
    (SeasonService as any).getActiveSeason = async () => ({
      id: "season12",
      number: 12,
      type: SeasonType.RANKED,
    });
    const result: any = await executeAiTool(
      "get_player_stats",
      '{"ign":"Backmobe"}',
      caller
    );
    assert(
      result.status === "no_stats" &&
        result.season === 12 &&
        result.recentSeasons[0].season === 11 &&
        result.recentSeasons[0].wins === 5,
      "No current stats is not the same as no recorded history"
    );
  } finally {
    prismaClient.player.findMany = previousPlayer;
    prismaClient.playerStats.findUnique = previousFind;
    prismaClient.playerStats.findMany = previousMany;
    SeasonService.getActiveSeason = previousSeason;
  }
});

test("Approved guides answer player participation and post-picking replacement without invented commands", () => {
  const guide = buildApprovedKnowledge(process.cwd());
  const play = retrieveApprovedKnowledge(
    guide,
    "how do I play a friendly war?",
    false
  );
  assert(
    play.some(
      (entry) =>
        entry.heading === "How do I play a Friendly War?" &&
        entry.content.includes("/register")
    ),
    "Player journey is available instead of organiser-only announcement steps"
  );
  const replacement = retrieveApprovedKnowledge(
    guide,
    "teams picked red player leaves how to replace announced game",
    true
  );
  assert(
    replacement.some(
      (entry) => entry.heading === "A player leaves after teams are picked"
    ),
    "Organiser receives roster correction guidance"
  );
});
