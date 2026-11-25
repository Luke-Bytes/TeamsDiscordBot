import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { prismaClient } from "../../src/database/prismaClient";
import { SeasonService } from "../../src/database/SeasonService";
import { ConfigManager } from "../../src/ConfigManager";
import { MVP_VOTE_ELO_BONUS } from "../../src/logic/Elo";
import {
  answerAiQuestion,
  boundedAiObservation,
  safeDiscordText,
} from "../../src/ai/AiAssistant";
import { autoReadsForAsk } from "../../src/ai/AiAutoReads";
import { AiCaller, executeAiTool } from "../../src/ai/AiTools";
import { getPlayerPerformanceShortlist } from "../../src/ai/PlayerPerformanceShortlist";
import { unverifiedSlashCommands } from "../../src/ai/DiscordAnswer";
import {
  requestedCoinFlips,
  requestedCoinPair,
  simulateCoinFlips,
} from "../../src/ai/NaviCoinFlips";
import { requestedTeammateHistory } from "../../src/ai/NaviTeammateHistory";
import { Team } from "@prisma/client";

const caller: AiCaller = {
  guildId: "offline-guild",
  discordUserId: "offline-viewer",
  verifyMembership: async () => ({ member: true, organiser: false }),
};

test("Navi coin flips are bounded real draws, not model-generated simulations", async () => {
  let draws = 0;
  const text = simulateCoinFlips(1000, () => {
    draws++;
    return draws <= 611 ? 0 : 1;
  });
  assert(
    draws === 1000 && text.includes("611 heads, 389 tails"),
    "Every requested flip is counted"
  );
  assert(
    !text.includes("Order"),
    "Large simulations produce a compact summary"
  );
  assert(
    simulateCoinFlips(10001, () => {
      throw new Error("unbounded");
    }).includes("10,000"),
    "Oversized simulations are rejected without drawing"
  );
  assert(
    requestedCoinFlips("How does /coinflip work?") === null,
    "Command help stays conversational"
  );
  assert(
    requestedCoinFlips("flip a coin 999 times") === 999,
    "Natural count request"
  );
  const pair = requestedCoinPair(
    "17 random coin flips between <@123456789012345678> and <@987654321098765432>"
  );
  assert(
    pair?.count === 17 && pair.labels[0] === "first mentioned user",
    "Resolve only order, never publish member IDs"
  );
  assert(
    simulateCoinFlips(17, () => 1, pair?.labels).includes(
      "second mentioned user won 17"
    ),
    "Pair results report actual draws"
  );
  const response = await answerAiQuestion({
    question: "100 random coin flips",
    organiser: false,
    caller,
    knowledge: [],
    infer: async () => {
      throw new Error("provider must not be called");
    },
  });
  const totals = /([0-9]+) heads, ([0-9]+) tails/.exec(response.text);
  assert(
    Boolean(totals && Number(totals[1]) + Number(totals[2]) === 100),
    "Actual results delivered without inference"
  );
});

test("Navi teammate superlatives use caller's finished same-team records", async () => {
  const beforePlayer = prismaClient.player.findUnique;
  const beforeNames = prismaClient.player.findMany;
  const beforeParticipation = prismaClient.gameParticipation.findMany;
  const beforeSeason = prismaClient.season.findUnique;
  try {
    (prismaClient.player as any).findUnique = async (args: any) => {
      assert(
        args.where.discordSnowflake === caller.discordUserId,
        "Self lookup uses verified caller"
      );
      return { id: "self" };
    };
    (prismaClient.season as any).findUnique = async (args: any) => {
      assert(args.where.number === 7, "Explicit season is preserved");
      return { id: "s7", number: 7 };
    };
    (prismaClient.gameParticipation as any).findMany = async (args: any) => {
      if (args.where.playerId === "self") {
        assert(
          args.where.seasonId === "s7" && args.where.game.is.finished === true,
          "Only finished season games"
        );
        return [
          { gameId: "g1", team: Team.RED, game: { winner: Team.RED } },
          { gameId: "g2", team: Team.BLUE, game: { winner: Team.BLUE } },
          { gameId: "g3", team: Team.RED, game: { winner: Team.BLUE } },
        ];
      }
      assert(
        args.where.playerId.not === "self" && args.where.OR.length === 2,
        "Lookup scoped to caller's teams"
      );
      return [
        { gameId: "g1", playerId: "a", team: Team.RED },
        { gameId: "g2", playerId: "a", team: Team.BLUE },
        { gameId: "g3", playerId: "a", team: Team.RED },
        { gameId: "g1", playerId: "b", team: Team.RED },
        { gameId: "g2", playerId: "b", team: Team.BLUE },
        { gameId: "g3", playerId: "opponent", team: Team.BLUE },
      ];
    };
    (prismaClient.player as any).findMany = async () => [
      { id: "a", latestIGN: "Alpha" },
      { id: "b", latestIGN: "Bravo" },
    ];
    const ask = (question: string) =>
      answerAiQuestion({
        question,
        organiser: false,
        caller,
        knowledge: [],
        infer: async () => {
          throw new Error("provider must not be called");
        },
      });
    const wins = await ask("Who have I won with the most in season 7?");
    assert(
      wins.text.includes("Alpha (2 wins in 3 games") &&
        wins.text.includes("Bravo (2 wins in 2 games") &&
        !wins.text.includes("opponent"),
      "Tied wins and correct samples, no opponents"
    );
    const games = await ask("Who have I played with the most in season 7?");
    assert(
      games.text.includes("Alpha") && !games.text.includes("Bravo"),
      "Games and wins rank independently"
    );
    assert(
      requestedTeammateHistory("Who has the most career wins?") === null,
      "Do not hijack global rankings"
    );
  } finally {
    prismaClient.player.findUnique = beforePlayer;
    prismaClient.player.findMany = beforeNames;
    prismaClient.gameParticipation.findMany = beforeParticipation;
    prismaClient.season.findUnique = beforeSeason;
  }
});

test("Conversational comparisons preload both season and lifetime metrics", () => {
  for (const question of [
    "Who is better, Ungenes or Backmobe?",
    "Does Ungenes have better game sense than Backmobe?",
    "Who should I pick for my team, Ungenes or Backmobe?",
  ]) {
    const reads = autoReadsForAsk(question);
    assert(
      reads.length === 4 &&
        reads.map((read) => read.name).join(",") ===
          "get_player_all_time_stats,get_player_stats,get_player_all_time_stats,get_player_stats" &&
        JSON.parse(reads[0].arguments).ign === "Ungenes" &&
        JSON.parse(reads[2].arguments).ign === "Backmobe",
      "Both named players receive career and active-season reads: " + question
    );
  }
  assert(
    autoReadsForAsk("Tell me a joke about gap dropping").length === 0,
    "Playful community questions do not consume stats tools"
  );
});

test("MVP leaders and games filters use existing performance evidence, not wins ranks", () => {
  assert(
    autoReadsForAsk("Who has the most MVPs?")[0]?.arguments ===
      '{"focus":"mvps"}',
    "MVP leaders select the recorded-MVP cohort"
  );
  const filtered = autoReadsForAsk(
    "Who are the best players with fewer than 30 games?"
  );
  assert(
    filtered[0]?.name === "get_player_performance_shortlist" &&
      JSON.parse(filtered[0].arguments).maxGames === 29,
    "Strict fewer-than filter is forwarded to the shortlist"
  );
  assert(
    JSON.parse(
      autoReadsForAsk("Who has the most MVPs under 30 games?")[0].arguments
    ).maxGames === 29 &&
      JSON.parse(
        autoReadsForAsk("Top Ranked players with fewer than 30 games")[0]
          .arguments
      ).maxGames === 29,
    "MVP and season-ranking requests do not silently discard sample-size filters"
  );
  assert(
    autoReadsForAsk("Who would you first pick in a draft?")[0]?.name ===
      "get_player_performance_shortlist",
    "Draft judgement uses diverse metrics, not most wins"
  );
});

test("Registered-player advice checks the real roster, while players cannot read organiser roster", () => {
  const q = "Who should I pick from the people currently registered?";
  const organiser = autoReadsForAsk(q, true).map((read) => read.name);
  assert(
    organiser.includes("get_current_game_state") &&
      organiser.includes("get_game_roster") &&
      !organiser.includes("get_all_time_leaderboard"),
    "Eligible roster takes precedence over historical leaders"
  );
  const member = autoReadsForAsk(q, false).map((read) => read.name);
  assert(
    member.includes("get_current_game_state") &&
      !member.includes("get_game_roster"),
    "Unprivileged questions never preload the private organiser roster"
  );
  const issue = autoReadsForAsk("Why is our announcement not appearing?", true);
  assert(
    issue.some((read) => read.name === "get_current_game_state") &&
      issue.some(
        (read) =>
          read.name === "get_game_discord_state" &&
          JSON.parse(read.arguments).focus === "announcement"
      ),
    "Troubleshooting checks process and Discord evidence rather than guessing"
  );
  assert(
    autoReadsForAsk("Why is the registration channel hidden?", true).some(
      (read) =>
        read.name === "get_game_discord_state" &&
        JSON.parse(read.arguments).focus === "announcement"
    ),
    "Registration visibility problems also inspect announcement delivery"
  );
});

test("Unknown commands and subcommands are identified from registered paths", async () => {
  const paths = [
    "/help",
    "/register",
    "/stats",
    "/announce",
    "/announce start",
    "/announce cancel",
    "/event",
    "/event question add",
    "/game",
    "/game shutdown",
  ];
  assert(
    unverifiedSlashCommands("Run /announce status then /set_elo", paths)
      .length === 2 &&
      unverifiedSlashCommands(
        "Use /announce start, then /game shutdown.",
        paths
      ).length === 0 &&
      unverifiedSlashCommands("Use /event question add.", paths).length === 0 &&
      unverifiedSlashCommands("Use /event question remove.", paths).length ===
        1 &&
      unverifiedSlashCommands("Try /stats player:Ungenes.", paths).length === 0,
    "Subcommand validation distinguishes genuine paths from plausible fiction and option names"
  );
  const beforeIdentity = prismaClient.player.findUnique;
  try {
    (prismaClient.player as any).findUnique = async () => null;
    const response = await answerAiQuestion({
      question: "How should I start the match?",
      caller: {
        ...caller,
        listCommands: async () => ({
          status: "ok",
          paths,
          commands: paths,
          total: paths.length,
        }),
      },
      organiser: false,
      knowledge: [],
      infer: async () => ({ content: "Try /announce status.", calls: [] }),
    });
    assert(
      !response.text.includes("/announce status") &&
        response.text.includes("/help"),
      "Unsupported command is never delivered as valid advice"
    );
    const publicCatalogue: any = await executeAiTool(
      "get_command_catalog",
      "{}",
      {
        ...caller,
        listCommands: async () => ({
          status: "ok",
          commands: ["/help: Show help"],
          paths,
          total: 1,
        }),
      }
    );
    assert(
      !("paths" in publicCatalogue) &&
        publicCatalogue.commands[0].includes("/help"),
      "Private command-validation paths do not bloat public model tool output"
    );
  } finally {
    prismaClient.player.findUnique = beforeIdentity;
  }
});

test("Elo explanation context follows actual config and calculation constant", async () => {
  const original = ConfigManager.getConfig;
  const previousIdentity = prismaClient.player.findUnique;
  try {
    (ConfigManager as any).getConfig = () => ({ captainBonus: 9, mvpBonus: 7 });
    (prismaClient.player as any).findUnique = async () => null;
    await answerAiQuestion({
      question: "How do Elo captain MVP and vote bonuses work with double Elo?",
      caller,
      organiser: false,
      knowledge: [],
      infer: async (messages) => {
        const evidence = messages[1]?.content ?? "";
        assert(
          evidence.includes("captain bonus +9") &&
            evidence.includes("selected MVP +7") &&
            evidence.includes("casting an MVP vote +" + MVP_VOTE_ELO_BONUS) &&
            evidence.includes("not bonuses or loss penalty") &&
            evidence.includes("either team"),
          "Rules are passed from real config/code, including losses and double-Elo"
        );
        return { content: "Bonuses are additive even on a loss.", calls: [] };
      },
    });
  } finally {
    ConfigManager.getConfig = original;
    prismaClient.player.findUnique = previousIdentity;
  }
});

test("Failed stats lookup never becomes a made-up zero or missing-player claim", async () => {
  const season = SeasonService.getActiveSeason;
  const identity = prismaClient.player.findUnique;
  try {
    (prismaClient.player as any).findUnique = async () => null;
    (SeasonService as any).getActiveSeason = async () => {
      throw new Error("offline DB failure");
    };
    const response = await answerAiQuestion({
      question: "Who are the top Ranked players this season?",
      caller,
      organiser: false,
      knowledge: [],
      infer: async () => ({ content: "No ranked players exist.", calls: [] }),
    });
    assert(
      !response.text.includes("No ranked players exist") &&
        response.text.includes("couldn't"),
      "A failed lookup cannot be described as an empty leaderboard"
    );
  } finally {
    SeasonService.getActiveSeason = season;
    prismaClient.player.findUnique = identity;
  }
});

test("Games-played shortlist filter checks wins plus losses and discloses partial coverage", async () => {
  const originals = {
    season: SeasonService.getActiveSeason,
    totals: prismaClient.playerStats.groupBy,
    seasonRows: prismaClient.playerStats.findMany,
    participation: prismaClient.gameParticipation.groupBy,
    players: prismaClient.player.findMany,
  };
  try {
    (SeasonService as any).getActiveSeason = async () => ({
      id: "active-season",
      number: 8,
      type: "RANKED",
    });
    (prismaClient.playerStats as any).groupBy = async (args: any) =>
      args.take === 24
        ? [{ playerId: "thirty" }, { playerId: "twentyfive" }]
        : [
            {
              playerId: "thirty",
              _sum: { wins: 29, losses: 1 },
              _max: { biggestWinStreak: 5 },
            },
            {
              playerId: "twentyfive",
              _sum: { wins: 10, losses: 15 },
              _max: { biggestWinStreak: 3 },
            },
          ];
    (prismaClient.playerStats as any).findMany = async (args: any) =>
      args.take === 24
        ? [{ playerId: "thirty" }, { playerId: "twentyfive" }]
        : [];
    (prismaClient.gameParticipation as any).groupBy = async () => [];
    (prismaClient.player as any).findMany = async () => [
      { id: "thirty", latestIGN: "ThirtyGames" },
      { id: "twentyfive", latestIGN: "TwentyFive" },
    ];
    const result: any = await getPlayerPerformanceShortlist({ maxGames: 29 });
    assert(
      result.status === "ok" &&
        result.candidates.length === 1 &&
        result.candidates[0].player === "TwentyFive" &&
        result.candidates[0].career.games === 25 &&
        result.filters.maxGames === 29 &&
        result.notes.includes("bounded candidate pool"),
      "A 29-1 player does not qualify as fewer than 30 games; filtered pool is not a universal leaderboard"
    );
  } finally {
    SeasonService.getActiveSeason = originals.season;
    prismaClient.playerStats.groupBy = originals.totals;
    prismaClient.playerStats.findMany = originals.seasonRows;
    prismaClient.gameParticipation.groupBy = originals.participation;
    prismaClient.player.findMany = originals.players;
  }
});

test("Overlarge roster observations retain eligible names without leaking unrelated state", () => {
  const summary = boundedAiObservation(
    "get_game_roster",
    {
      status: "ok",
      source: "current process memory",
      truncated: false,
      rosters: {
        UNDECIDED: { total: 1, players: [{ latestIGN: "RosterIGN" }] },
      },
      extra: "x".repeat(6000),
    },
    "Who should I pick from the roster?"
  );
  assert(
    summary.includes("RosterIGN") &&
      summary.includes("Partial process-memory") &&
      !summary.includes("xxxx") &&
      summary.length <= 4000,
    "Oversized roster still supports actual eligible-player recommendations"
  );
});

test("Overlong output ends cleanly and only observed recording URLs survive", () => {
  const long = safeDiscordText("This sentence is complete. ".repeat(100));
  assert(
    long.length <= 1450 &&
      long.endsWith(".") &&
      !long.endsWith("complete") &&
      !long.endsWith("sentence"),
    "Final length cap preserves completed sentences"
  );
  const video = "https://www.youtube.com/watch?v=icpcNFnAbsU";
  const reply = safeDiscordText(
    "Recording: " +
      video +
      ". Outside: https://evil.example/a and unknown: https://www.youtube.com/watch?v=aaaaaaaaaaa",
    [video]
  );
  assert(
    reply.includes(video) &&
      reply.includes("[link omitted]") &&
      !reply.includes("evil.example") &&
      !reply.includes("aaaaaaaaaaa"),
    "Only precisely allowlisted, syntactically valid YouTube URLs are kept"
  );
});
