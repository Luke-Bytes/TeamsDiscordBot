import { Team } from "@prisma/client";
import { assert } from "../framework/assert";
import { test } from "../framework/test";
import {
  buildAllSeasonTierDossiers,
  buildPlacementPromptPayload,
  createTierListState,
  placeNextPlayer,
  suggestConsistencyMoves,
} from "../../src/logic/tierList/AllSeasonTierList";
import { filterCommunityAnswers } from "../../src/logic/tierList/CommunityNotes";
import { TierListEventManager } from "../../src/logic/tierList/TierListEventManager";
import {
  OllamaTierJudge,
  parsePlacementResponse,
} from "../../src/logic/tierList/OllamaTierJudge";
import TierListCommand from "../../src/commands/TierListCommand";
import {
  ConfigManager,
  DEFAULT_OLLAMA_CONFIG,
  DEFAULT_TIER_LIST_CONFIG,
} from "../../src/ConfigManager";
import {
  PlayerTierDossier,
  TierListState,
} from "../../src/logic/tierList/types";
import {
  calculateTierListImageLayout,
  emptyTierListImageRows,
  TierListHeadCache,
  truncateTierListName,
} from "../../src/logic/tierList/TierListImageRenderer";
import {
  SeasonRecapData,
  SeasonRecapGame,
} from "../../src/logic/seasonRecap/SeasonRecap";

const base = new Date("2026-01-01T19:00:00.000Z");

function player(id: string) {
  return {
    id,
    latestIGN: id,
    discordSnowflake: `10000000000000${id.padEnd(4, "0")}`,
  };
}

function game(
  season: number,
  idx: number,
  redIds: string[],
  blueIds: string[],
  winner: Team,
  opts: { mvp?: string; captains?: string[] } = {}
): SeasonRecapGame {
  const start = new Date(
    base.getTime() + (season * 100 + idx) * 24 * 60 * 60 * 1000
  );
  const participants = [
    ...redIds.map((id, pos) => ({
      playerId: id,
      ignUsed: id,
      team: Team.RED,
      mvp: opts.mvp === id,
      captain: opts.captains?.includes(id) ?? pos === 0,
      draftSlotPlacement: pos + 1,
      votedForAMVP: true,
      player: player(id),
    })),
    ...blueIds.map((id, pos) => ({
      playerId: id,
      ignUsed: id,
      team: Team.BLUE,
      mvp: opts.mvp === id,
      captain: opts.captains?.includes(id) ?? pos === 0,
      draftSlotPlacement: redIds.length + pos + 1,
      votedForAMVP: true,
      player: player(id),
    })),
  ];

  return {
    id: `s${season}-g${idx}`,
    finished: true,
    startTime: start,
    endTime: new Date(start.getTime() + 45 * 60 * 1000),
    winner,
    type: "DRAFT",
    doubleElo: idx % 4 === 0,
    organiser: "Org",
    host: "Host",
    settings: {
      map: idx % 2 === 0 ? "DUELSTAL" : "CANYON1V1",
      organiserBannedClasses: [],
      sharedCaptainBannedClasses: [],
      nonSharedCaptainBannedClasses: { RED: [], BLUE: [] },
      modifiers: idx % 3 === 0 ? [{ category: "Pace", name: "Fast Iron" }] : [],
    },
    gameParticipations: participants,
  };
}

function seasonData(
  seasonNumber: number,
  games: SeasonRecapGame[],
  finalElos: Record<string, number>
): SeasonRecapData {
  const playerIds = Array.from(
    new Set(
      games.flatMap((item) => item.gameParticipations.map((gp) => gp.playerId))
    )
  );
  const wins = new Map<string, number>();
  const losses = new Map<string, number>();
  for (const item of games) {
    for (const gp of item.gameParticipations) {
      const target = gp.team === item.winner ? wins : losses;
      target.set(gp.playerId, (target.get(gp.playerId) ?? 0) + 1);
    }
  }

  return {
    seasonNumber,
    games,
    playerStats: playerIds.map((id) => ({
      playerId: id,
      elo: finalElos[id] ?? 1000,
      wins: wins.get(id) ?? 0,
      losses: losses.get(id) ?? 0,
      winStreak: 0,
      loseStreak: 0,
      biggestWinStreak: 0,
      biggestLosingStreak: 0,
      player: player(id),
    })),
    histories: games.flatMap((item, gameIndex) =>
      item.gameParticipations.map((gp) => ({
        playerId: gp.playerId,
        gameId: item.id,
        elo: (finalElos[gp.playerId] ?? 1000) - (games.length - gameIndex) * 2,
        createdAt: new Date(item.endTime.getTime() + 1000),
      }))
    ),
  };
}

function fixture() {
  const gamesOne = [
    game(1, 0, ["ace", "steady"], ["volume", "foil"], Team.RED, {
      mvp: "ace",
      captains: ["ace", "volume"],
    }),
    game(1, 1, ["ace", "steady"], ["volume", "foil"], Team.RED, {
      mvp: "ace",
      captains: ["ace", "volume"],
    }),
    game(1, 2, ["ace", "steady"], ["volume", "foil"], Team.BLUE, {
      captains: ["ace", "volume"],
    }),
    game(1, 3, ["ace", "steady"], ["volume", "foil"], Team.RED, {
      captains: ["ace", "volume"],
    }),
    game(1, 4, ["onegame", "foil"], ["ace", "steady"], Team.RED, {
      mvp: "onegame",
    }),
  ];
  const gamesTwo = [
    game(2, 0, ["ace", "steady"], ["volume", "foil"], Team.RED, {
      mvp: "ace",
      captains: ["ace", "volume"],
    }),
    game(2, 1, ["steady", "foil"], ["volume", "bench"], Team.BLUE, {
      captains: ["steady", "volume"],
    }),
    game(2, 2, ["steady", "foil"], ["volume", "bench"], Team.RED, {
      captains: ["steady", "volume"],
    }),
    game(2, 3, ["steady", "foil"], ["volume", "bench"], Team.BLUE, {
      captains: ["steady", "volume"],
    }),
  ];

  return [
    seasonData(1, gamesOne, {
      ace: 1210,
      steady: 1110,
      volume: 930,
      foil: 970,
      onegame: 1060,
    }),
    seasonData(2, gamesTwo, {
      ace: 1190,
      steady: 1090,
      volume: 940,
      foil: 980,
      bench: 960,
    }),
  ];
}

test("All-season tier dossiers aggregate seasons and keep one-game players provisional", () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const ace = find(dossiers, "ace");
  const onegame = find(dossiers, "onegame");

  assert(ace.seasonsPlayed === 2, "Ace should aggregate across two seasons");
  assert(ace.stats.mvpCount === 3, "MVP count should aggregate");
  assert(
    ace.stats.doubleEloGames > 0,
    "Double Elo game context should be tracked"
  );
  assert(!ace.provisional, "Multi-game player should not be provisional");
  assert(
    onegame.provisional,
    "One-game perfect record should remain provisional"
  );
  assert(
    onegame.statisticalBand !== "S",
    "One-game perfect record should not be auto-promoted to S"
  );
});

test("All-season tier scoring does not reward games played by itself", () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const ace = find(dossiers, "ace");
  const volume = find(dossiers, "volume");

  assert(
    volume.gamesPlayed > ace.gamesPlayed,
    "Fixture should give volume more games than ace"
  );
  assert(
    volume.score < ace.score,
    "Higher volume alone should not outrank better adjusted performance"
  );
});

test("Placement prompt includes existing tier references and avoids Discord snowflakes", () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const state = createTierListState(dossiers);
  const first = placeNextPlayer(dossiers, state);
  assert(!!first, "First placement should succeed");

  const next = dossiers.find(
    (dossier) => dossier.playerId === state.unplacedPlayerIds[0]
  );
  assert(!!next, "Next dossier should exist");
  const payload = buildPlacementPromptPayload(next!, dossiers, state);
  const json = JSON.stringify(payload);

  assert(
    payload.nearestComparables.length > 0,
    "Prompt should include placed statistical comparables"
  );
  assert(
    Object.values(payload.currentTierList).some((names) =>
      names.includes(first!.displayName)
    ),
    "Prompt should include existing tier list state"
  );
  assert(!/10000000000000/.test(json), "Prompt should not expose Discord IDs");
});

test("Placement prompt labels manual and community notes as subjective", () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const state = createTierListState(dossiers);
  const next = dossiers[0];
  const payload = buildPlacementPromptPayload(next, dossiers, state, {
    communityNotesSummary: "Strong team support according to chat.",
    manualNotes: ["Often shotcalls late-game rush timing."],
  });

  assert(
    payload.communityNotes?.warning === "subjective community context",
    "Community notes should be labeled subjective"
  );
  assert(
    payload.manualNotes?.[0].startsWith("Subjective organiser note:"),
    "Manual notes should be labeled subjective"
  );
});

test("Tier-list manager skip and undo mutate queue and placements safely", () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const manager = new TierListEventManager();
  const state = manager.start(dossiers);
  const firstId = state.unplacedPlayerIds[0];
  const skipped = manager.skipNext();

  assert(skipped?.playerId === firstId, "Skip should move the front player");
  assert(
    state.unplacedPlayerIds.at(-1) === firstId,
    "Skipped player should move to the end"
  );

  const placement = placeNextPlayer(dossiers, state);
  assert(!!placement, "A placement should be committed");
  const undone = manager.undoLastPlacement();
  assert(
    undone?.playerId === placement!.playerId,
    "Undo should pop last placement"
  );
  assert(
    state.unplacedPlayerIds[0] === placement!.playerId,
    "Undone player should return to the front"
  );
});

test("Tier-list manager applies pending consistency moves only when requested", () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const manager = new TierListEventManager();
  const state = manager.start(dossiers);
  const target = placement("upper-b", "UpperB", "B", 80, "medium");
  state.placed.B.push(target);
  state.placementHistory.push(target);
  manager.setPendingConsistencyMoves([
    {
      playerId: target.playerId,
      player: target.displayName,
      targetTier: "A",
      targetPosition: "low",
      suggestion: "Move UpperB to low A.",
    },
  ]);

  const applied = manager.applyPendingConsistencyMoves();
  assert(applied.length === 1, "Should apply one pending move");
  assert(state.placed.B.length === 0, "Player should leave old tier");
  assert(
    state.placed.A.some((candidate) => candidate.playerId === target.playerId),
    "Player should enter target tier"
  );
});

test("Tier-list question session accepts only configured channel and one answer per user", async () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const manager = new TierListEventManager();
  manager.start(dossiers);
  const promise = manager.beginQuestion(dossiers[0], "questions", 10000, 5);

  manager.handleMessage(
    fakeMessage("wrong", "u1", "Strong team support value.")
  );
  manager.handleMessage(
    fakeMessage(
      "questions",
      "u1",
      "Strong team-first support player who communicates mid pressure well."
    )
  );
  manager.handleMessage(
    fakeMessage(
      "questions",
      "u1",
      "Duplicate user with another long support answer should be ignored."
    )
  );
  manager.handleMessage(fakeMessage("questions", "u2", "/tierlist next"));
  manager.finishQuestion("continue", 5);

  const result = await promise;
  assert(result.notes.accepted.length === 1, "Should keep one useful answer");
});

test("Consistency pass suggests small moves without rewriting the whole list", () => {
  const state: TierListState = {
    eventId: "test",
    createdAt: new Date(),
    unplacedPlayerIds: [],
    placed: {
      S: [],
      A: [placement("lower-a", "LowerA", "A", 68, "medium")],
      B: [placement("upper-b", "UpperB", "B", 80, "medium")],
      C: [],
      D: [],
      E: [],
    },
    placementHistory: [],
    reasoningByPlayerId: {},
    manualNotesByPlayerId: {},
    discardedCommunityNotePlayerIds: [],
    skippedPlayerIds: [],
    placementCount: 0,
    postedImageMessageIds: [],
  };

  const suggestions = suggestConsistencyMoves(state);
  assert(suggestions.length === 1, "Should suggest one small consistency move");
  assert(
    suggestions[0].suggestion.includes("low A"),
    "Suggestion should be bounded to a nearby tier"
  );
});

test("Community answer filtering removes spam, duplicates, low-content, and tier commands", () => {
  const notes = filterCommunityAnswers([
    { userId: "1", content: "put them S tier" },
    { userId: "2", content: "lol" },
    {
      userId: "3",
      content:
        "Strong team-first support player who communicates mid pressure well.",
    },
    {
      userId: "3",
      content:
        "Second answer from same user should be ignored despite being long.",
    },
    {
      userId: "4",
      content:
        "Comparable to other flex players because they defend then rush late.",
    },
  ]);

  assert(notes.accepted.length === 2, "Should keep two useful notes");
  assert(
    notes.rejected.some((item) => item.reason === "direct tier command"),
    "Should reject direct tier commands"
  );
  assert(!!notes.summary, "Accepted notes should produce a summary");
});

test("Ollama tier judge parser accepts fenced JSON and strips thinking text", () => {
  const parsed = parsePlacementResponse(`
<think>Compare against references first.</think>
\`\`\`json
{
  "tier": "A",
  "position": "mid",
  "reasoning": "Comparable to existing A references with stronger MVP signal but less sample size.",
  "confidence": "medium"
}
\`\`\`
`);

  assert(parsed.tier === "A", "Should parse tier");
  assert(parsed.position === "mid", "Should parse position");
  assert(parsed.confidence === "medium", "Should parse confidence");
});

test("Ollama tier judge parser rejects invalid tier output", () => {
  let rejected = false;
  try {
    parsePlacementResponse(
      JSON.stringify({
        tier: "SS",
        position: "high",
        reasoning:
          "This is long enough but uses a tier outside the allowed list.",
        confidence: "high",
      })
    );
  } catch (error) {
    void error;
    rejected = true;
  }

  assert(rejected, "Invalid tier should be rejected");
});

test("Tier-list command uses code defaults when tier-list config is omitted", () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = undefined;

  try {
    const command = new TierListCommand() as any;
    const tierConfig = command.tierConfig();
    const imageConfig = command.tierImageConfig();

    assert(
      tierConfig.enabledCommunityQuestions === true,
      "Community questions should default to enabled"
    );
    assert(
      imageConfig.enabled === true,
      "Image snapshots should default to enabled"
    );
    assert(
      tierConfig.questionWindowSeconds ===
        DEFAULT_TIER_LIST_CONFIG.questionWindowSeconds,
      "Tier timing should use code defaults"
    );
    assert(
      imageConfig.headUrlTemplate ===
        DEFAULT_TIER_LIST_CONFIG.image.headUrlTemplate,
      "Image config should use code defaults"
    );
  } finally {
    config.tierList = originalTierList;
  }
});

test("Tier-list image config merges nested overrides over defaults", () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    image: {
      enabled: false,
    },
  };

  try {
    const command = new TierListCommand() as any;
    const imageConfig = command.tierImageConfig();
    assert(
      imageConfig.enabled === false,
      "Image enabled override should apply"
    );
    assert(
      imageConfig.width === DEFAULT_TIER_LIST_CONFIG.image.width,
      "Missing nested image values should fall back to defaults"
    );
  } finally {
    config.tierList = originalTierList;
  }
});

test("Ollama status uses enabled code defaults when llm config is omitted", async () => {
  const config = ConfigManager.getConfig();
  const originalLlm = config.llm;
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  config.llm = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({ models: [{ name: DEFAULT_OLLAMA_CONFIG.model }] }),
      { headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const status = await new OllamaTierJudge().status();
    assert(status.enabled === true, "Ollama should default to enabled");
    assert(
      status.baseUrl === DEFAULT_OLLAMA_CONFIG.baseUrl,
      "Ollama should use default base URL"
    );
    assert(
      status.model === DEFAULT_OLLAMA_CONFIG.model,
      "Ollama should use default model"
    );
    assert(
      requestedUrl === `${DEFAULT_OLLAMA_CONFIG.baseUrl}/api/tags`,
      "Ollama status should call default tags endpoint"
    );
    assert(status.modelAvailable, "Default model should be recognised");
  } finally {
    globalThis.fetch = originalFetch;
    config.llm = originalLlm;
  }
});

test("Ollama judge uses enabled code defaults when llm config is omitted", async () => {
  const config = ConfigManager.getConfig();
  const originalLlm = config.llm;
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody = {} as { model?: string };
  config.llm = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
    };
    return new Response(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            tier: "A",
            position: "mid",
            confidence: "medium",
            reasoning:
              "The dossier compares well with strong A-tier references and has enough evidence for a stable placement.",
          }),
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const result = await new OllamaTierJudge().judge({
      player: {
        displayName: "DefaultModel",
        gamesPlayed: 12,
        seasonsPlayed: 2,
        provisional: false,
        statisticalBand: "A",
        score: 120,
        objectiveSummary: "Strong all-round profile.",
        notableStrengths: ["wins"],
        riskNotes: [],
        confidenceNotes: [],
        stats: {
          wins: 8,
          losses: 4,
          winRate: 0.67,
          adjustedWinScore: 0.67,
          mvpCount: 1,
          mvpRate: 0.08,
          smoothedMvpRate: 0.08,
          captainGames: 0,
          captainWins: 0,
          captainWinRate: null,
          underdogWins: 1,
          draftGames: 0,
          averageDraftSlotPercentile: null,
          draftValue: 0,
          peakElo: 1100,
          finalEloAverage: 1080,
          averageElo: 1060,
          averageSeasonEloPercentile: 0.7,
          maps: {},
          modifiers: {},
          gameTypes: {},
          doubleEloGames: 0,
        },
      },
      currentTierList: { S: [], A: [], B: [], C: [], D: [], E: [] },
      nearestComparables: [],
      placementInstructions: [],
      instructions: [],
    });

    assert(result.source === "ollama", "Judge should use Ollama by default");
    assert(
      requestedUrl === `${DEFAULT_OLLAMA_CONFIG.baseUrl}/api/chat`,
      "Judge should call default chat endpoint"
    );
    assert(
      requestedBody.model === DEFAULT_OLLAMA_CONFIG.model,
      "Judge should send default model"
    );
  } finally {
    globalThis.fetch = originalFetch;
    config.llm = originalLlm;
  }
});

test("Ollama judge respects explicit disabled override", async () => {
  const config = ConfigManager.getConfig();
  const originalLlm = config.llm;
  config.llm = { ollama: { enabled: false } };

  try {
    const result = await new OllamaTierJudge().judge({
      player: {
        displayName: "DisabledModel",
        gamesPlayed: 1,
        seasonsPlayed: 1,
        provisional: true,
        statisticalBand: "C",
        score: 0,
        objectiveSummary: "Small sample.",
        notableStrengths: [],
        riskNotes: [],
        confidenceNotes: [],
        stats: {
          wins: 0,
          losses: 1,
          winRate: 0,
          adjustedWinScore: 0,
          mvpCount: 0,
          mvpRate: 0,
          smoothedMvpRate: 0,
          captainGames: 0,
          captainWins: 0,
          captainWinRate: null,
          underdogWins: 0,
          draftGames: 0,
          averageDraftSlotPercentile: null,
          draftValue: 0,
          peakElo: 1000,
          finalEloAverage: 1000,
          averageElo: 1000,
          averageSeasonEloPercentile: 0.5,
          maps: {},
          modifiers: {},
          gameTypes: {},
          doubleEloGames: 0,
        },
      },
      currentTierList: { S: [], A: [], B: [], C: [], D: [], E: [] },
      nearestComparables: [],
      placementInstructions: [],
      instructions: [],
    });

    assert(result.source === "fallback", "Disabled Ollama should fall back");
  } finally {
    config.llm = originalLlm;
  }
});

test("Tier-list image layout keeps empty rows at the base height", () => {
  const layout = calculateTierListImageLayout(emptyTierListImageRows(), {
    width: 500,
    labelColumnWidth: 100,
    baseRowHeight: 80,
    cellSize: 40,
    gap: 10,
    padding: 10,
    fontSize: 12,
    maxImageHeight: 1000,
  });

  assert(layout.pages.length === 1, "Empty snapshot should fit one page");
  assert(
    layout.pages[0].rows.every((row) => row.height === 80),
    "Every empty tier row should keep base height"
  );
});

test("Tier-list image layout wraps crowded rows and increases row height", () => {
  const rows = emptyTierListImageRows();
  rows.S = Array.from({ length: 18 }, (_, index) => ({
    displayName: `Player${index}`,
  }));
  const layout = calculateTierListImageLayout(rows, {
    width: 360,
    labelColumnWidth: 80,
    baseRowHeight: 80,
    cellSize: 48,
    gap: 8,
    padding: 8,
    fontSize: 12,
    maxImageHeight: 1000,
  });
  const sRow = layout.pages[0].rows.find((row) => row.tier === "S");

  assert(!!sRow, "S row should be present");
  assert(sRow!.height > 80, "Crowded row should grow taller than base height");
});

test("Tier-list image names truncate before they exceed cell width", () => {
  const truncated = truncateTierListName(
    "VeryLongMinecraftUsernameThatWillNotFit",
    72,
    16
  );

  assert(truncated.endsWith("…"), "Long names should receive an ellipsis");
  assert(truncated.length < 20, "Truncated name should be compact");
});

test("Tier-list image layout splits tall snapshots into pages", () => {
  const rows = emptyTierListImageRows();
  for (const tier of Object.keys(rows) as Array<keyof typeof rows>) {
    rows[tier] = Array.from({ length: 20 }, (_, index) => ({
      displayName: `${tier}${index}`,
    }));
  }
  const layout = calculateTierListImageLayout(rows, {
    width: 300,
    labelColumnWidth: 70,
    baseRowHeight: 80,
    cellSize: 44,
    gap: 8,
    padding: 8,
    fontSize: 12,
    maxImageHeight: 240,
  });

  assert(layout.pages.length > 1, "Tall layout should be paginated");
  assert(
    layout.pages.every((page) => page.height <= 240),
    "Each page should respect max height"
  );
});

test("Tier-list head cache reuses successful fetches and falls back on errors", async () => {
  let calls = 0;
  const transparentPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lVJ5VwAAAABJRU5ErkJggg==",
    "base64"
  );
  const cache = new TierListHeadCache(
    "https://example.invalid/{identifier}/{size}.png",
    (async () => {
      calls += 1;
      return new Response(transparentPng);
    }) as typeof fetch
  );
  const first = await cache.load("Valid", 16);
  const second = await cache.load("Valid", 16);
  assert(first.length > 0 && second.length > 0, "Successful head should load");
  assert(calls === 1, "Successful fetch should be cached");

  const failing = new TierListHeadCache(
    "https://example.invalid/{identifier}/{size}.png",
    (async () => {
      throw new Error("network disabled");
    }) as typeof fetch
  );
  const fallback = await failing.load("", 16);
  assert(fallback.length > 0, "Failed or missing head should use placeholder");
});

test("Tier-list next posts one snapshot for each committed placement", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: true },
  };
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 2);
  command.manager.start(dossiers);
  command.tierJudge = judgeForPayload();
  let posts = 0;
  command.postTierListImageSnapshot = async () => {
    posts += 1;
  };

  try {
    await command.next({
      options: { getInteger: () => 2 },
      deferReply: async () => {},
      editReply: async () => {},
      followUp: async () => {},
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(posts === 2, "Two committed placements should post two snapshots");
});

test("Tier-list undo and consistency apply request corrected snapshots", async () => {
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 2);
  command.manager.start(dossiers);
  const placementValue = {
    playerId: dossiers[0].playerId,
    displayName: dossiers[0].displayName,
    tier: "B" as const,
    position: "mid" as const,
    reasoning: "test",
    confidence: "medium" as const,
    score: dossiers[0].score,
  };
  command.manager.commitPlacement(placementValue);
  let posts = 0;
  command.postTierListImageSnapshot = async () => {
    posts += 1;
  };
  await command.undo({
    reply: async () => {},
    channel: { isTextBased: () => false },
  });
  assert(posts === 1, "Undo should request a corrected snapshot");

  command.manager.commitPlacement(placementValue);
  command.manager.setPendingConsistencyMoves([
    {
      playerId: dossiers[0].playerId,
      player: dossiers[0].displayName,
      targetTier: "A",
      targetPosition: "low",
      suggestion: "move",
    },
  ]);
  await command.handleButtonPress({
    customId: "tierlist:apply-consistency",
    guild: {},
    member: { roles: { cache: { has: () => true } } },
    update: async () => {},
  } as any);
  assert(posts === 2, "Consistency apply should request a corrected snapshot");
});

test("Tier-list image posting failure does not fail placement", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: true },
  };
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 1);
  command.manager.start(dossiers);
  command.tierJudge = judgeForPayload();
  command.postTierListImageSnapshot = async () => {
    throw new Error("render failed");
  };
  let edited = false;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await command.next({
      options: { getInteger: () => 1 },
      deferReply: async () => {},
      editReply: async () => {
        edited = true;
      },
      followUp: async () => {},
      channel: { isTextBased: () => false },
    });
  } finally {
    console.error = originalConsoleError;
    config.tierList = originalTierList;
  }

  assert(edited, "Placement response should still be sent");
  assert(
    command.manager.getState().placementCount === 1,
    "Placement should remain committed"
  );
});

function find(dossiers: PlayerTierDossier[], playerId: string) {
  const dossier = dossiers.find((candidate) => candidate.playerId === playerId);
  assert(!!dossier, `Expected dossier for ${playerId}`);
  return dossier!;
}

function placement(
  playerId: string,
  displayName: string,
  tier: "A" | "B",
  score: number,
  confidence: "medium"
) {
  return {
    playerId,
    displayName,
    tier,
    position: "mid" as const,
    reasoning: "test",
    confidence,
    score,
  };
}

function fakeMessage(channelId: string, userId: string, content: string) {
  return {
    channelId,
    content,
    author: { id: userId, bot: false },
  } as any;
}

function judgeForPayload() {
  return {
    judge: async () => ({
      source: "ollama",
      placement: {
        tier: "B",
        position: "mid",
        reasoning: "Comparable to existing references with stable value.",
        confidence: "medium",
      },
    }),
  };
}
