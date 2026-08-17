import { Team } from "@prisma/client";
import { assert } from "../framework/assert";
import { test } from "../framework/test";
import { withImmediateTimers } from "../framework/timers";
import {
  applyLimitedSampleGuardrail,
  assignStatisticalBands,
  buildAllSeasonTierDossiers,
  buildPlacementPromptPayload,
  createTierListState,
  placeNextPlayer,
  suggestConsistencyMoves,
  TIER_LIST_REASONING_STYLE_INSTRUCTION,
} from "../../src/logic/tierList/AllSeasonTierList";
import { filterCommunityAnswers } from "../../src/logic/tierList/CommunityNotes";
import { TierListEventManager } from "../../src/logic/tierList/TierListEventManager";
import { prismaClient } from "../../src/database/prismaClient";
import {
  OllamaTierJudge,
  parseFinalVerdictResponse,
  parseFinalReviewResponse,
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
  TierPlacement,
} from "../../src/logic/tierList/types";
import {
  calculateTierListImageLayout,
  emptyTierListImageRows,
  fitTierListName,
  TierListHeadCache,
} from "../../src/logic/tierList/TierListImageRenderer";
import {
  SeasonRecapData,
  SeasonRecapGame,
} from "../../src/logic/seasonRecap/SeasonRecap";
import { escapeText } from "../../src/util/Utils";

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
      captains: ["steady", "volume"],
    }),
    game(1, 1, ["ace", "steady"], ["volume", "foil"], Team.RED, {
      mvp: "ace",
      captains: ["steady", "volume"],
    }),
    game(1, 2, ["ace", "steady"], ["volume", "foil"], Team.BLUE, {
      captains: ["ace", "volume"],
    }),
    game(1, 3, ["ace", "steady"], ["volume", "foil"], Team.RED, {
      captains: ["ace", "volume"],
    }),
    game(1, 4, ["onegame", "foil"], ["ace", "steady"], Team.RED, {
      mvp: "onegame",
      captains: ["foil", "ace"],
    }),
  ];
  const gamesTwo = [
    game(2, 0, ["ace", "steady"], ["volume", "foil"], Team.RED, {
      mvp: "ace",
      captains: ["steady", "volume"],
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

test("All-season tier dossiers track each player's most recent finished game", () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const ace = find(dossiers, "ace");
  const bench = find(dossiers, "bench");

  assert(
    ace.lastPlayedAt.getTime() ===
      game(2, 0, ["ace"], [], Team.RED).startTime.getTime(),
    "Ace should use their latest finished game date"
  );
  assert(
    bench.lastPlayedAt.getTime() ===
      game(2, 3, [], ["bench"], Team.BLUE).startTime.getTime(),
    "Bench should use their only finished game date"
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

test("All-season tier summaries surface MVP, captain, adjusted win, and all-season Elo context", () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const ace = find(dossiers, "ace");

  assert(
    ace.objectiveSummary.includes("all-season games") &&
      ace.objectiveSummary.includes("adjusted win score"),
    "Objective summary should lead with all-season volume and adjusted wins"
  );
  assert(
    ace.objectiveSummary.includes("eligible non-captain games") &&
      ace.objectiveSummary.includes("eligible non-MVP games") &&
      ace.objectiveSummary.includes("captain wins ("),
    "Objective summary should include MVP/captain opportunity denominators and captain percentages"
  );
  assert(
    ace.objectiveSummary.includes("all-season avg Elo") &&
      ace.objectiveSummary.includes("avg season Elo percentile"),
    "Objective summary should label Elo as all-season average context"
  );
});

test("All-season tier rates use MVP and captain opportunity denominators", () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const ace = find(dossiers, "ace");

  assert(ace.stats.mvpCount === 3, "Fixture should give Ace three MVPs");
  assert(
    ace.stats.mvpEligibleGames === 3,
    "MVP eligible games should exclude captain games"
  );
  assert(
    ace.stats.mvpRate === 1,
    "MVP rate should be MVPs divided by non-captain games"
  );
  assert(
    ace.stats.captainGames === 3,
    "Fixture should give Ace three captain games"
  );
  assert(
    ace.stats.captainEligibleGames === 3,
    "Captain eligible games should exclude MVP games"
  );
  assert(
    ace.stats.captainRate === 1,
    "Captain rate should be captain games divided by non-MVP games"
  );
});

test("All-season tier risks mark tiny captain samples as provisional context", () => {
  const dossiers = buildAllSeasonTierDossiers([
    seasonData(
      1,
      [
        game(1, 0, ["tinycap", "ally"], ["enemy", "control"], Team.RED, {
          captains: ["tinycap", "enemy"],
        }),
      ],
      {
        tinycap: 1050,
        ally: 1000,
        enemy: 1000,
        control: 1000,
      }
    ),
  ]);
  const tinycap = find(dossiers, "tinycap");

  assert(
    tinycap.riskNotes.some((note) =>
      note.includes("1/1 captain wins is promising but too small")
    ),
    "One-game captain record should be promising but low confidence"
  );
});

test("All-season tier dossiers mark fewer than six games as limited sample and keep bands to C/D", () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const onegame = find(dossiers, "onegame");
  const bench = find(dossiers, "bench");

  assert(onegame.limitedSample, "One-game player should be limited sample");
  assert(bench.limitedSample, "Four-game player should be limited sample");
  assert(
    ["C", "D"].includes(onegame.statisticalBand),
    "Limited samples should only receive C/D statistical bands"
  );
  assert(
    ["C", "D"].includes(bench.statisticalBand),
    "Limited samples should only receive C/D statistical bands"
  );
});

test("Low-sample scoring shrinks volatile perfect records away from S/A/B bands", () => {
  const dossier = buildAllSeasonTierDossiers([
    seasonData(
      1,
      [
        game(1, 0, ["spike", "ally"], ["enemy", "control"], Team.RED, {
          mvp: "spike",
          captains: ["ally", "enemy"],
        }),
      ],
      {
        spike: 1600,
        ally: 900,
        enemy: 900,
        control: 900,
      }
    ),
  ]).find((candidate) => candidate.playerId === "spike");

  assert(!!dossier, "Spike dossier should exist");
  assert(dossier!.limitedSample, "One-game spike should be limited sample");
  assert(
    ["C", "D"].includes(dossier!.statisticalBand),
    "One-game perfect MVP captain Elo spike should not auto-reach S/A/B"
  );
});

test("All-season tier scoring gives capped credit for strong captain impact despite average raw record", () => {
  const captainGames = [
    game(1, 0, ["leader", "ally"], ["enemy", "control"], Team.RED, {
      captains: ["leader", "enemy"],
    }),
    game(1, 1, ["leader", "ally"], ["enemy", "control"], Team.RED, {
      captains: ["leader", "enemy"],
    }),
    game(1, 2, ["leader", "ally"], ["enemy", "control"], Team.RED, {
      captains: ["leader", "enemy"],
    }),
    game(1, 3, ["ally", "control"], ["leader", "enemy"], Team.RED, {
      captains: ["ally", "enemy"],
    }),
    game(1, 4, ["ally", "control"], ["leader", "enemy"], Team.RED, {
      captains: ["ally", "enemy"],
    }),
    game(1, 5, ["ally", "control"], ["leader", "enemy"], Team.RED, {
      captains: ["ally", "enemy"],
    }),
  ];
  const dossiers = buildAllSeasonTierDossiers([
    seasonData(1, captainGames, {
      leader: 1000,
      control: 1000,
      ally: 1000,
      enemy: 1000,
    }),
  ]);
  const leader = find(dossiers, "leader");
  const control = find(dossiers, "control");

  assert(leader.stats.winRate === 0.5, "Leader raw record should be average");
  assert(
    leader.stats.captainWinRate === 1,
    "Leader should have a strong captain win rate"
  );
  assert(
    leader.stats.smoothedCaptainWinRate !== null &&
      leader.stats.smoothedCaptainWinRate < 1,
    "Captain impact should be smoothed rather than taking tiny samples literally"
  );
  assert(
    leader.objectiveSummary.includes("sample-smoothed"),
    "Dossier summary should tell the judge that captain rate is sample-smoothed"
  );
  assert(
    leader.score > control.score,
    "Strong captain impact should help a player avoid being buried by average raw record"
  );
});

test("Tier-list statistical bands center the pool on C", () => {
  const dossiers = assignStatisticalBands(syntheticDossierDrafts(100));
  const counts = tierCounts(dossiers);

  assert(counts.C === 40, "C should receive the largest average band");
  assert(counts.B === 20, "B should be above average, not the midpoint");
  assert(counts.S === 2, "S should stay rare under the default curve");
});

test("Tier-list S band remains tiny for large pools", () => {
  const dossiers = assignStatisticalBands(syntheticDossierDrafts(500));
  const counts = tierCounts(dossiers);

  assert(counts.S === 10, "S should stay at roughly the top two percent");
  assert(counts.C === 200, "C should remain the main population");
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
    payload.instructions.some((line) =>
      line.includes("C is the community-average")
    ),
    "Prompt should explain that C is average"
  );
  assert(
    payload.instructions.some((line) => line.includes("S is for exceptional")),
    "Prompt should explain that S is rare"
  );
  assert(
    payload.instructions.some((line) =>
      line.includes("Raw team-game win rate is team-context evidence")
    ),
    "Prompt should explicitly de-emphasize raw team win rate"
  );
  assert(
    payload.instructions.some((line) =>
      line.includes("MVP count/rate, captain games, captain win rate")
    ),
    "Prompt should prioritize stronger individual signals"
  );
  assert(
    payload.instructions.some((line) =>
      line.includes("Elo values are all-season averages/percentiles")
    ),
    "Prompt should clarify Elo context"
  );
  assert(
    payload.instructions.some((line) => line.includes("Low-sample players")) &&
      payload.instructions.some((line) =>
        line.includes("S, A, and E are unavailable")
      ),
    "Prompt should include low-sample guardrail instructions"
  );
  assert(
    payload.placementInstructions.includes(
      TIER_LIST_REASONING_STYLE_INSTRUCTION
    ),
    "Prompt should tell the model not to mention total matches except for low sample context"
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

test("Tier-list start copy uses players and queue preview names only", async () => {
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 3);
  command.loadDossiers = async () => dossiers;
  let reply: any;

  await command.start({
    options: { getInteger: () => null, getBoolean: () => null },
    deferReply: async () => {},
    editReply: async (payload: any) => {
      reply = payload;
    },
  });

  const embed = reply.embeds[0].toJSON();
  const rendered = JSON.stringify(embed);
  assert(
    embed.title === "All-Season Tier List: Queue Locked",
    "Start response should use the live-event embed"
  );
  assert(
    rendered.includes(String(dossiers.length)),
    "Player count should show"
  );
  assert(
    !rendered.includes("dossier"),
    "Start copy should not mention dossiers"
  );
  assert(rendered.includes("Coming up:"), "Queue preview should be shown");
  assert(rendered.includes("15s"), "Default auto-advance should be 15s");
  assert(
    !/\([SABCDE]\)/.test(rendered),
    "Queue preview should not show estimate bands"
  );
});

test("Tier-list start randomizes queue order independently of score order", async () => {
  const command = new TierListCommand() as any;
  const dossiers = assignStatisticalBands(syntheticDossierDrafts(4));
  command.loadDossiers = async () => dossiers;

  await withMockedRandom([0, 0, 0], async () => {
    await command.start(startInteraction(null, null));
  });

  const state = command.manager.getState();
  assert(
    state.unplacedPlayerIds.join(",") !==
      dossiers.map((dossier) => dossier.playerId).join(","),
    "Queue order should not stay in score order when shuffled"
  );
  assert(
    state.unplacedPlayerIds.join(",") ===
      [
        dossiers[1].playerId,
        dossiers[2].playerId,
        dossiers[3].playerId,
        dossiers[0].playerId,
      ].join(","),
    "Queue order should follow the deterministic Fisher-Yates shuffle"
  );
});

test("Tier-list start played_recently filters before applying limit", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    playedRecentlyDefault: false,
    playedRecentlyMonths: 6,
  };
  const command = new TierListCommand() as any;
  const dossiers = assignStatisticalBands(syntheticDossierDrafts(4));
  const now = new Date();
  dossiers[0].lastPlayedAt = monthsBefore(now, 1);
  dossiers[1].lastPlayedAt = monthsBefore(now, 2);
  dossiers[2].lastPlayedAt = monthsBefore(now, 8);
  dossiers[3].lastPlayedAt = monthsBefore(now, 9);
  command.loadDossiers = async () => dossiers;
  let reply: any;

  try {
    await withMockedRandom([0], async () => {
      await command.start({
        options: {
          getInteger: (name: string) =>
            name === "limit" ? 1 : name === "played_recently" ? 3 : null,
          getBoolean: () => null,
        },
        deferReply: async () => {},
        editReply: async (payload: any) => {
          reply = payload;
        },
      });
    });
  } finally {
    config.tierList = originalTierList;
  }

  const state = command.manager.getState();
  assert(
    state.unplacedPlayerIds.length === 1,
    "Limit should apply after recency filtering"
  );
  assert(
    state.unplacedPlayerIds[0] === dossiers[1].playerId,
    "Limit should select from the randomized recent-player sample"
  );
  assert(
    JSON.stringify(reply.embeds[0].toJSON()).includes("last 3 months"),
    "Start embed should show requested recent filter"
  );
});

test("Tier-list start limit samples from all eligible players", async () => {
  const command = new TierListCommand() as any;
  const dossiers = assignStatisticalBands(syntheticDossierDrafts(5));
  command.loadDossiers = async () => dossiers;

  await withMockedRandom([0, 0, 0, 0], async () => {
    await command.start(startInteraction(2, null));
  });

  const state = command.manager.getState();
  assert(
    state.unplacedPlayerIds.length === 2,
    "Limit should still cap the selected queue size"
  );
  assert(
    state.unplacedPlayerIds.includes(dossiers[2].playerId),
    "Limit should sample from the full eligible shuffled list, not old top-N"
  );
  assert(
    !state.unplacedPlayerIds.includes(dossiers[0].playerId),
    "The old top-ranked player should not be forced into the limited queue"
  );
});

test("Tier-list start omits recent filter even when old config default is true", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    playedRecentlyDefault: true,
    playedRecentlyMonths: 6,
  };
  const command = new TierListCommand() as any;
  const dossiers = assignStatisticalBands(syntheticDossierDrafts(2));
  const now = new Date();
  dossiers[0].lastPlayedAt = monthsBefore(now, 1);
  dossiers[1].lastPlayedAt = monthsBefore(now, 12);
  command.loadDossiers = async () => dossiers;

  try {
    await command.start(startInteraction(null, null));
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    command.manager.getState().unplacedPlayerIds.length === 2,
    "Omitted option should include all eligible players"
  );
});

test("Tier-list start played_recently integer overrides old config default window", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    playedRecentlyDefault: true,
    playedRecentlyMonths: 12,
  };
  const command = new TierListCommand() as any;
  const dossiers = assignStatisticalBands(syntheticDossierDrafts(3));
  const now = new Date();
  dossiers[0].lastPlayedAt = monthsBefore(now, 1);
  dossiers[1].lastPlayedAt = monthsBefore(now, 4);
  dossiers[2].lastPlayedAt = monthsBefore(now, 8);
  command.loadDossiers = async () => dossiers;
  let reply: any;

  try {
    await command.start({
      ...startInteraction(null, 3),
      editReply: async (payload: any) => {
        reply = payload;
      },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    command.manager.getState().unplacedPlayerIds.length === 1,
    "Command month value should control the recency filter"
  );
  assert(
    JSON.stringify(reply.embeds[0].toJSON()).includes("last 3 months"),
    "Start embed should show command-provided month value"
  );
});

test("Tier-list fast mode embed shows requested played_recently window", () => {
  const command = new TierListCommand() as any;
  const rendered = JSON.stringify(
    command.fastModeProcessingEmbed(5, 3).toJSON()
  );

  assert(
    rendered.includes("last 3 months"),
    "Fast mode embed should show command-provided month value"
  );
});

test("Tier-list start defaults to no recent filter and six months without tierList config", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = undefined;
  const command = new TierListCommand() as any;
  const dossiers = assignStatisticalBands(syntheticDossierDrafts(2));
  dossiers[0].lastPlayedAt = monthsBefore(new Date(), 1);
  dossiers[1].lastPlayedAt = monthsBefore(new Date(), 12);
  command.loadDossiers = async () => dossiers;
  let reply: any;

  try {
    await command.start({
      ...startInteraction(null, null),
      editReply: async (payload: any) => {
        reply = payload;
      },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    command.manager.getState().unplacedPlayerIds.length === 2,
    "Missing tierList config should default playedRecentlyDefault to false"
  );
  assert(
    !JSON.stringify(reply.embeds[0].toJSON()).includes("Recent filter"),
    "Disabled recent filter should keep existing start copy"
  );
  assert(
    DEFAULT_TIER_LIST_CONFIG.playedRecentlyMonths === 6,
    "Code default recent activity window should be six months"
  );
});

test("Tier-list registered command surface hides review tools", () => {
  const command = new TierListCommand();
  const names = command.data
    .toJSON()
    .options?.map((option) => option.name)
    .join(", ");

  assert(
    names === "start, next, show, undo, skip, rereview, final, reset",
    "Registered tier-list commands should stay to the organiser-controlled flow"
  );
});

test("Tier-list start played_recently is an integer month option", () => {
  const command = new TierListCommand();
  const start = command.data
    .toJSON()
    .options?.find((option: any) => option.name === "start") as any;
  const playedRecently = start.options.find(
    (option: any) => option.name === "played_recently"
  );

  assert(playedRecently.type === 4, "played_recently should be integer");
  assert(playedRecently.min_value === 1, "Recent window should require >=1");
  assert(playedRecently.max_value === 60, "Recent window should cap months");
});

test("First tier-list next places without asking a community question", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: true,
    askCommunityEveryNPlayers: 1,
    image: { enabled: false },
  };
  const command = new TierListCommand() as any;
  command.manager.start(buildAllSeasonTierDossiers(fixture()).slice(0, 2));
  command.tierJudge = judgeForPayload();
  let asked = false;

  try {
    await command.next({
      options: { getInteger: () => 1 },
      deferReply: async () => {},
      editReply: async () => {},
      followUp: async () => {},
      guild: {
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            send: async () => {
              asked = true;
            },
          }),
        },
      },
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(!asked, "First player should not trigger a community question");
  assert(
    command.manager.getState().placementCount === 1,
    "First player should still be placed"
  );
});

test("Low-sample first placement forces a community question when enabled", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: true,
    askCommunityEveryNPlayers: 10,
    image: { enabled: false },
  };
  const command = new TierListCommand() as any;
  command.manager.start([lowSampleDossier("low-first")]);
  command.tierJudge = judgeForPayload();
  let asked = false;

  try {
    const nextPromise = command.next({
      options: { getInteger: () => 1 },
      deferReply: async () => {},
      editReply: async () => {},
      followUp: async () => {},
      guild: {
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            send: async () => {
              asked = true;
            },
          }),
        },
      },
      channel: { isTextBased: () => false },
    });
    await waitForTick();
    command.manager.finishQuestion("continue", 5);
    await nextPromise;
  } finally {
    config.tierList = originalTierList;
  }

  assert(asked, "Low-sample first player should trigger a question");
  assert(
    command.manager.getState().placementCount === 1,
    "Low-sample player should still be placed after question closes"
  );
});

test("Low-sample placement guardrail clamps tiers based on accepted context", () => {
  const dossier = lowSampleDossier("guarded");
  const base: TierPlacement = {
    playerId: dossier.playerId,
    displayName: dossier.displayName,
    tier: "S",
    position: "high",
    reasoning: "Small sample model output tried an elite tier.",
    confidence: "high",
    score: dossier.score,
  };

  const clampedS = applyLimitedSampleGuardrail(dossier, base, false);
  const clampedB = applyLimitedSampleGuardrail(
    dossier,
    { ...base, tier: "B" },
    false
  );
  const allowedB = applyLimitedSampleGuardrail(
    dossier,
    { ...base, tier: "B" },
    true
  );
  const clampedE = applyLimitedSampleGuardrail(
    dossier,
    { ...base, tier: "E" },
    false
  );

  assert(
    clampedS.tier === "C",
    "Low-sample S/A should clamp to C without notes"
  );
  assert(clampedB.tier === "C", "Low-sample B should require accepted notes");
  assert(allowedB.tier === "B", "Low-sample B should be allowed with notes");
  assert(clampedE.tier === "D", "Low-sample E should clamp to D");
  assert(
    clampedS.reasoning.includes("Limited sample size"),
    "Clamped reasoning should mention limited sample size"
  );
});

test("Tier-list community questions include concrete public option lists", async () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const manager = new TierListEventManager();
  manager.start(dossiers);
  const dossier = find(dossiers, "steady");

  const questionPromise = manager.beginQuestion(dossier, "questions", 10000, 5);
  const questions = new Set<string>();
  const active = manager.getActiveQuestion();
  if (active) questions.add(active.question);
  for (let i = 0; i < 10; i += 1) {
    const question = manager.rerollQuestion();
    if (question) questions.add(question);
  }
  manager.finishQuestion("discard", 5);
  await questionPromise;

  assert(
    questions.size >= 5,
    "Should rotate through the public non-comparison questions"
  );
  for (const question of questions) {
    assert(
      question.includes("Options:"),
      `Question should include concrete options: ${question}`
    );
    assert(
      !question.toLowerCase().includes("organisers"),
      `Public question should not mention organisers: ${question}`
    );
  }
  assert(
    Array.from(questions).some(
      (question) =>
        question.includes("Rusher") && question.includes("Gold Miner")
    ),
    "Role question should use profile role labels as options"
  );
});

test("Tier-list anchor selection caps significant players and keeps non-anchor order", () => {
  const manager = new TierListEventManager();
  const dossiers = assignStatisticalBands([
    ...Array.from({ length: 12 }, (_, index) =>
      anchorDossier(`anchor-${index}`, 30 - index, 90 - index)
    ),
    anchorDossier("low-games", 14, 95),
    lowSampleDossier("tiny"),
  ]);

  const state = manager.start(dossiers);
  const anchorIds = state.anchorPlayerIds;
  const anchorIdSet = new Set(anchorIds);

  assert(state.phase === "anchor", "Eligible anchors should start pre-phase");
  assert(anchorIds.length === 10, "Anchor phase should cap at 10 players");
  assert(
    anchorIds.every((playerId) => find(dossiers, playerId).gamesPlayed >= 15),
    "Anchors should only include players with at least 15 games"
  );
  assert(
    state.unplacedPlayerIds.slice(0, anchorIds.length).join(",") ===
      anchorIds.join(","),
    "Selected queue should place anchors first"
  );
  assert(
    state.unplacedPlayerIds.slice(anchorIds.length).join(",") ===
      dossiers
        .filter((dossier) => !anchorIdSet.has(dossier.playerId))
        .map((dossier) => dossier.playerId)
        .join(","),
    "Non-anchor players should retain their randomized relative order"
  );
});

test("Tier-list anchor phase skips when no significant anchors exist", () => {
  const manager = new TierListEventManager();
  const state = manager.start([
    lowSampleDossier("one"),
    lowSampleDossier("two"),
  ]);

  assert(
    state.phase === "provisional",
    "No eligible anchors should skip phase"
  );
  assert(state.anchorPlayerIds.length === 0, "No anchors should be stored");
});

test("Tier-list anchor polling accepts A-E once per voter and advances", async () => {
  const manager = new TierListEventManager();
  const state = manager.start([
    anchorDossier("first-anchor", 30, 90),
    anchorDossier("second-anchor", 25, 70),
  ]);

  const first = manager.currentAnchorDossier();
  assert(!!first, "First anchor should be active");
  const firstPoll = manager.beginAnchorPoll(first!, "questions", 10000);
  manager.handleMessage(fakeMessage("questions", "u1", "z"));
  manager.handleMessage(fakeMessage("questions", "u1", "A"));
  manager.handleMessage(fakeMessage("questions", "u1", "B"));
  manager.handleMessage(fakeMessage("questions", "u2", "a"));
  manager.handleMessage(fakeMessage("other", "u3", "E"));
  manager.finishAnchorPoll();
  const firstSummary = await firstPoll;

  assert(firstSummary.votes.A === 2, "A votes should be counted");
  assert(firstSummary.votes.B === 0, "Duplicate voter should be ignored");
  assert(firstSummary.votes.E === 0, "Other-channel votes should be ignored");
  assert(firstSummary.consensus === "A", "Consensus should use the top vote");
  assert(state.phase === "anchor", "Second anchor should still be pending");

  const second = manager.currentAnchorDossier();
  assert(!!second, "Second anchor should be active");
  const secondPoll = manager.beginAnchorPoll(second!, "questions", 10000);
  manager.handleMessage(fakeMessage("questions", "u1", "E"));
  manager.finishAnchorPoll();
  const secondSummary = await secondPoll;

  assert(secondSummary.consensus === "E", "Second vote should be stored");
  assert(state.phase === "provisional", "All anchors should unlock placement");
});

test("Tier-list anchor poll escapes pre-escaped display names once", () => {
  const command = new TierListCommand() as any;
  const dossier = anchorDossier("escaped-anchor", 30, 90);
  dossier.displayName = "oak_sapling\\\\_";
  dossier.objectiveSummary = "oak_sapling\\\\_: established __summary__.";

  const content = command.anchorPollContent(dossier, 1, 1);

  assert(
    content.includes("oak\\_sapling\\_"),
    "Anchor poll should show a single Discord escape for underscores"
  );
  assert(
    !content.includes("\\\\\\\\_"),
    "Anchor poll should not leak doubled backslash escapes"
  );
  assert(
    content.includes("established \\_\\_summary\\_\\_"),
    "Anchor poll summary should be escaped too"
  );
});

test("Tier-list next is blocked while anchor phase is active", async () => {
  const command = new TierListCommand() as any;
  command.manager.start([anchorDossier("blocked-anchor", 30, 90)]);
  let reply = "";

  await command.next({
    options: { getInteger: () => 1 },
    deferReply: async () => {},
    editReply: async (content: string) => {
      reply = content;
    },
  });

  assert(
    reply.includes("Anchor community voting is still active"),
    "Next should explain that anchor voting must finish first"
  );
  assert(
    command.manager.getState().placementCount === 0,
    "Blocked next should not place anyone"
  );
});

test("Placement prompt includes anchor vote context only for matching player", () => {
  const manager = new TierListEventManager();
  const state = manager.start([
    anchorDossier("voted-anchor", 30, 90),
    anchorDossier("other-anchor", 25, 70),
  ]);
  state.anchorVotesByPlayerId["voted-anchor"] = {
    playerId: "voted-anchor",
    displayName: "voted-anchor",
    votes: { A: 5, B: 2, C: 0, D: 0, E: 0 },
    consensus: "A",
    totalVotes: 7,
  };
  state.phase = "provisional";

  const votedPayload = buildPlacementPromptPayload(
    find(manager.getDossiers(), "voted-anchor"),
    manager.getDossiers(),
    state
  );
  const otherPayload = buildPlacementPromptPayload(
    find(manager.getDossiers(), "other-anchor"),
    manager.getDossiers(),
    state
  );

  assert(
    votedPayload.communityNotes?.summary.includes(
      "Community rough tier vote: A=5, B=2; consensus A"
    ),
    "Matching anchor should include its rough community vote"
  );
  assert(
    !JSON.stringify(otherPayload).includes("Community rough tier vote"),
    "Other players should not receive unrelated anchor vote context"
  );
  assert(
    votedPayload.placementInstructions.some((instruction) =>
      instruction.includes("never as direct tier commands")
    ),
    "Prompt should keep community input subjective"
  );
});

test("Tier-list comparison question waits for placed players", async () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const manager = new TierListEventManager();
  const state = manager.start(dossiers);
  const comparisonDossier = find(dossiers, "steady");

  const firstQuestion = manager.beginQuestion(
    comparisonDossier,
    "questions",
    10000,
    5
  );
  const firstQuestions = new Set<string>();
  const firstSession = manager.getActiveQuestion();
  if (firstSession) firstQuestions.add(firstSession.question);
  for (let i = 0; i < 10; i += 1) {
    const question = manager.rerollQuestion();
    if (question) firstQuestions.add(question);
  }
  manager.finishQuestion("discard", 5);
  await firstQuestion;

  assert(
    !Array.from(firstQuestions).some((question) =>
      question.includes("placed player")
    ),
    "Comparison question should not be used before placements"
  );

  manager.commitPlacement({
    playerId: "ace",
    displayName: "ace",
    tier: "B",
    position: "mid",
    reasoning: "test",
    confidence: "medium",
    score: 10,
  });
  assert(state.placementCount === 1, "Fixture should now have a placement");

  const secondQuestion = manager.beginQuestion(
    comparisonDossier,
    "questions",
    10000,
    5
  );
  const secondQuestions = new Set<string>();
  const secondSession = manager.getActiveQuestion();
  if (secondSession) secondQuestions.add(secondSession.question);
  for (let i = 0; i < 10; i += 1) {
    const question = manager.rerollQuestion();
    if (question) secondQuestions.add(question);
  }
  manager.finishQuestion("discard", 5);
  await secondQuestion;

  assert(
    !Array.from(secondQuestions).some((question) =>
      question.includes("placed player")
    ),
    "Comparison question should still wait until every tier has a placement"
  );

  for (const tier of ["S", "A", "C", "D", "E"] as const) {
    manager.commitPlacement({
      playerId: `placed-${tier}`,
      displayName: `Placed${tier}`,
      tier,
      position: "mid",
      reasoning: "test",
      confidence: "medium",
      score: 10,
    });
  }

  const thirdQuestion = manager.beginQuestion(
    comparisonDossier,
    "questions",
    10000,
    5
  );
  const thirdQuestions = new Set<string>();
  const thirdSession = manager.getActiveQuestion();
  if (thirdSession) thirdQuestions.add(thirdSession.question);
  for (let i = 0; i < 10; i += 1) {
    const question = manager.rerollQuestion();
    if (question) thirdQuestions.add(question);
  }
  manager.finishQuestion("discard", 5);
  await thirdQuestion;
  const comparisonQuestion = Array.from(thirdQuestions).find((question) =>
    question.includes("placed player")
  );

  assert(
    !!comparisonQuestion,
    "Comparison question can be used once every tier has a placement"
  );
  assert(
    comparisonQuestion?.includes("ace") &&
      comparisonQuestion.includes("PlacedS"),
    "Comparison question should include current placed-player options"
  );
  assert(
    comparisonQuestion?.includes("Options:"),
    "Comparison question should render dynamic placed-player options"
  );
});

test("Tier-list come back later button moves active player to queue end", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: true,
    askCommunityEveryNPlayers: 1,
    image: { enabled: false },
  };
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 3);
  const state = command.manager.start(dossiers);
  command.manager.commitPlacement({
    playerId: dossiers[0].playerId,
    displayName: dossiers[0].displayName,
    tier: "B",
    position: "mid",
    reasoning: "test",
    confidence: "medium",
    score: dossiers[0].score,
  });
  command.tierJudge = judgeForPayload();
  const activePlayerId = state.unplacedPlayerIds[0];
  let questionComponents: any[] = [];
  let editReply: any;

  try {
    const nextPromise = command.next({
      options: { getInteger: () => 1 },
      deferReply: async () => {},
      editReply: async (payload: any) => {
        editReply = payload;
      },
      followUp: async () => {},
      guild: {
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            send: async (payload: { components: any[] }) => {
              questionComponents = payload.components;
            },
          }),
        },
      },
      channel: { isTextBased: () => false },
    });
    await waitForTick();

    const skipButton = questionComponents[0].components.find(
      (component: any) => component.data.custom_id === "tierlist:skip-active"
    );
    assert(
      skipButton.data.label === "Come back later",
      "Question button should use come back later wording"
    );

    await command.handleButtonPress({
      customId: "tierlist:skip-active",
      guild: {},
      member: { roles: { cache: { has: () => true } } },
      deferUpdate: async () => {},
    } as any);
    await nextPromise;
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    state.unplacedPlayerIds.at(-1) === activePlayerId,
    "Come back later should move the active player to the end"
  );
  assert(
    JSON.stringify(editReply.embeds[0].toJSON()).includes("Skipped"),
    "Placement response should report the deferred player"
  );
});

test("Tier-list question buttons remain organiser-only", async () => {
  const command = new TierListCommand() as any;
  let replyPayload: any;
  let deferred = false;

  await command.handleButtonPress({
    customId: "tierlist:question-pause",
    guild: {},
    member: { roles: { cache: { has: () => false } } },
    reply: async (payload: any) => {
      replyPayload = payload;
    },
    deferUpdate: async () => {
      deferred = true;
    },
  } as any);

  assert(!deferred, "Non-organiser button press should not control question");
  assert(
    String(replyPayload?.content).includes("Only organisers"),
    "Non-organiser should receive a permission message"
  );
});

test("Tier-list community question components include pause timer", () => {
  const command = new TierListCommand() as any;
  const components = command.questionComponents();
  const pauseButton = components[0].components.find(
    (component: any) => component.data.custom_id === "tierlist:question-pause"
  );

  assert(!!pauseButton, "Question controls should include a pause button");
  assert(
    pauseButton.data.label === "Pause timer",
    "Pause button should clearly label the timer action"
  );
});

test("Tier-list community question components include public context buttons", () => {
  const command = new TierListCommand() as any;
  const components = command.questionComponents();

  assert(
    hasComponent({ components }, "tierlist:old-names"),
    "Question controls should include Old names"
  );
  assert(
    hasComponent({ components }, "tierlist:extend-time"),
    "Question controls should include Extend time"
  );
  assert(
    !hasComponent(
      { components: command.anchorPollComponents() },
      "tierlist:old-names"
    ),
    "Anchor polls should not include Old names"
  );
  assert(
    !hasComponent(
      { components: command.anchorPollComponents() },
      "tierlist:extend-time"
    ),
    "Anchor polls should not include Extend time"
  );
});

test("Tier-list public context buttons bypass organiser-only controls", async () => {
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture());
  command.manager.start(dossiers);
  const promise = command.manager.beginQuestion(
    dossiers[0],
    "questions",
    10000,
    5
  );
  let replyPayload: any;

  await command.handleButtonPress({
    customId: "tierlist:extend-time",
    user: { id: "non-organiser" },
    guild: {},
    member: { roles: { cache: { has: () => false } } },
    reply: async (payload: any) => {
      replyPayload = payload;
    },
  } as any);

  assert(
    String(replyPayload?.content).includes("Extension vote recorded"),
    "Non-organisers should be able to vote for time extension"
  );
  assert(
    !String(replyPayload?.content).includes("Only organisers"),
    "Public context button should not hit organiser gate"
  );

  command.manager.finishQuestion("discard", 5);
  await promise;
});

test("Tier-list old names posts de-duped escaped stored names publicly", async () => {
  const command = new TierListCommand() as any;
  const dossier = lowSampleDossier("player-id");
  dossier.displayName = "Current_Name";
  command.manager.start([dossier]);
  const promise = command.manager.beginQuestion(dossier, "questions", 10000, 5);
  const originalFindUnique = (prismaClient as any).player.findUnique;
  let replyPayload: any;

  (prismaClient as any).player.findUnique = async ({ where }: any) => {
    assert(where.id === "player-id", "Old names should look up active player");
    return {
      latestIGN: "Current_Name",
      minecraftAccounts: ["Primary_Name", "current_name", "Old*Name"],
    };
  };

  try {
    await command.handleButtonPress({
      customId: "tierlist:old-names",
      reply: async (payload: any) => {
        replyPayload = payload;
      },
    } as any);
  } finally {
    (prismaClient as any).player.findUnique = originalFindUnique;
    command.manager.finishQuestion("discard", 5);
    await promise;
  }

  const embed = replyPayload.embeds[0].toJSON();
  const rendered = JSON.stringify(embed);
  assert(
    embed.title === "Known names for Current\\_Name",
    "Old names title should use escaped dossier display name"
  );
  assert(
    rendered.includes("Current\\\\_Name (current)") &&
      rendered.includes("Primary\\\\_Name (primary)") &&
      rendered.includes("Old\\\\*Name"),
    "Old names embed should mark current, primary, and escape stored names"
  );
  assert(
    (rendered.match(/Current\\\\_Name/g) ?? []).length === 2,
    "Duplicate latest/current names should be de-duped across the list"
  );
  assert(
    embed.thumbnail?.url.includes("Current_Name"),
    "Old names embed should use the current name for the head thumbnail"
  );
});

test("Tier-list old names without an active question returns ephemeral error", async () => {
  const command = new TierListCommand() as any;
  let replyPayload: any;

  await command.handleButtonPress({
    customId: "tierlist:old-names",
    reply: async (payload: any) => {
      replyPayload = payload;
    },
  } as any);

  assert(
    String(replyPayload?.content).includes("No active tier-list question"),
    "Old names should require an active question"
  );
  assert(
    !!replyPayload?.flags,
    "No active question response should be ephemeral"
  );
});

test("Tier-list extend time requires two unique voters and extends once", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers: Array<{ delay: number; cleared: boolean }> = [];
  (global as any).setTimeout = (_callback: () => void, delay: number) => {
    const timer = { delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  (global as any).clearTimeout = (handle: any) => {
    handle.cleared = true;
  };

  try {
    const dossiers = buildAllSeasonTierDossiers(fixture());
    const manager = new TierListEventManager();
    manager.start(dossiers);
    const promise = manager.beginQuestion(dossiers[0], "questions", 10000, 5);

    const first = manager.requestQuestionExtension("u1", 30000, 2, 5);
    const duplicate = manager.requestQuestionExtension("u1", 30000, 2, 5);
    const second = manager.requestQuestionExtension("u2", 30000, 2, 5);
    const third = manager.requestQuestionExtension("u3", 30000, 2, 5);

    assert(
      first.status === "recorded" && first.votes === 1,
      "First unique extension vote should be recorded only"
    );
    assert(
      duplicate.status === "recorded" && duplicate.votes === 1,
      "Duplicate extension vote should not increase the count"
    );
    assert(second.status === "extended", "Second unique vote should extend");
    assert(
      timers.length === 2 && timers[0].cleared && timers[1].delay >= 39000,
      "Extension should clear the original timer and add 30 seconds to the existing deadline"
    );
    assert(
      third.status === "already-extended",
      "Further extension votes should not extend again"
    );

    manager.finishQuestion("discard", 5);
    await promise;
  } finally {
    (global as any).setTimeout = originalSetTimeout as any;
    (global as any).clearTimeout = originalClearTimeout as any;
  }
});

test("Tier-list organiser pause updates the question without finishing it", async () => {
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture());
  command.manager.start(dossiers);
  const promise = command.manager.beginQuestion(
    dossiers[0],
    "questions",
    10000,
    5
  );
  let updatePayload: any;

  await command.handleButtonPress({
    customId: "tierlist:question-pause",
    guild: {},
    member: { roles: { cache: { has: () => true } } },
    update: async (payload: any) => {
      updatePayload = payload;
    },
  } as any);

  assert(
    command.manager.getActiveQuestion()?.paused === true,
    "Organiser pause should leave the question open and paused"
  );
  assert(
    String(updatePayload?.content).includes("Window: paused"),
    "Pause should update the message with paused wording"
  );

  command.manager.finishQuestion("discard", 5);
  await promise;
});

test("Tier-list continue after pause finishes the question normally", async () => {
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture());
  command.manager.start(dossiers);
  const promise = command.manager.beginQuestion(
    dossiers[0],
    "questions",
    10000,
    5
  );
  let deferred = false;

  await command.handleButtonPress({
    customId: "tierlist:question-pause",
    guild: {},
    member: { roles: { cache: { has: () => true } } },
    update: async () => {},
  } as any);
  command.manager.handleMessage(
    fakeMessage(
      "questions",
      "u1",
      "Consistent pressure player with useful support calls late game."
    )
  );
  await command.handleButtonPress({
    customId: "tierlist:continue",
    guild: {},
    member: { roles: { cache: { has: () => true } } },
    deferUpdate: async () => {
      deferred = true;
    },
  } as any);

  const result = await promise;
  assert(deferred, "Continue should acknowledge the button update");
  assert(result.action === "continue", "Continue should finish the question");
  assert(
    result.notes.accepted.length === 1,
    "Continue after pause should keep valid answers"
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

test("Tier-list final command refuses while provisional players remain", async () => {
  const command = new TierListCommand() as any;
  command.manager.start(buildAllSeasonTierDossiers(fixture()).slice(0, 2));
  let reply: any;

  await command.final({
    reply: async (payload: any) => {
      reply = payload;
    },
  });

  assert(
    reply.content.includes("provisional placement is complete"),
    "Final review should wait until the queue is empty"
  );
});

test("Tier-list final review payload includes tier players and adjacent references", () => {
  const dossiers = assignStatisticalBands(syntheticDossierDrafts(6));
  const manager = new TierListEventManager();
  const state = manager.start(dossiers);
  state.unplacedPlayerIds = [];
  manager.commitPlacement(placement("s1", "SOne", "S", 99, "medium"));
  manager.commitPlacement(placement("a1", "AOne", "A", 90, "medium"));
  manager.commitPlacement(placement("a2", "ATwo", "A", 88, "medium"));
  manager.commitPlacement(placement("b1", "BOne", "B", 80, "medium"));

  const payload = manager.buildFinalReviewPayload("A");

  assert(payload?.players.length === 2, "Payload should include all A players");
  assert(
    payload?.adjacentReferences.higherTier?.some(
      (item) => item.displayName === "SOne"
    ),
    "Payload should include higher boundary references"
  );
  assert(
    payload?.adjacentReferences.lowerTier?.some(
      (item) => item.displayName === "BOne"
    ),
    "Payload should include lower boundary references"
  );
  assert(
    payload?.players[0].statContext &&
      typeof payload.players[0].statContext.adjustedWinScore === "number",
    "Final review payload should keep compact stat context"
  );
  assert(
    payload?.instructions.includes(TIER_LIST_REASONING_STYLE_INSTRUCTION),
    "Final review prompt should avoid public total-match wording except for low sample context"
  );
});

test("Tier-list final review segment payload includes only that segment", () => {
  const dossiers = assignStatisticalBands(syntheticDossierDrafts(6));
  const manager = new TierListEventManager();
  const state = manager.start(dossiers);
  state.unplacedPlayerIds = [];
  const high = placement("a1", "AHigh", "A", 90, "medium");
  high.position = "high";
  const mid = placement("a2", "AMid", "A", 88, "medium");
  mid.position = "mid";
  const low = placement("a3", "ALow", "A", 86, "medium");
  low.position = "low";
  manager.commitPlacement(placement("s1", "SLow", "S", 99, "medium"));
  manager.commitPlacement(high);
  manager.commitPlacement(mid);
  manager.commitPlacement(low);
  manager.commitPlacement(placement("b1", "BHigh", "B", 80, "medium"));

  const payload = manager.buildFinalReviewSegmentPayload("A", "mid", ["a2"]);

  assert(payload?.segment === "mid", "Payload should identify the segment");
  assert(payload?.players.length === 1, "Payload should include only mid");
  assert(
    payload?.players[0].displayName === "AMid",
    "Payload should preserve segment membership"
  );
  assert(
    payload?.sameTierReferences?.higherSegment?.some(
      (item) => item.displayName === "AHigh"
    ),
    "Payload should include nearby same-tier higher references"
  );
  assert(
    payload?.sameTierReferences?.lowerSegment?.some(
      (item) => item.displayName === "ALow"
    ),
    "Payload should include nearby same-tier lower references"
  );
  assert(
    payload?.adjacentReferences.higherTier?.length &&
      payload.adjacentReferences.lowerTier?.length,
    "Payload should include adjacent tier boundaries"
  );
  assert(
    payload?.instructions.includes(TIER_LIST_REASONING_STYLE_INSTRUCTION),
    "Segment final review prompt should avoid public total-match wording except for low sample context"
  );
});

test("Tier-list final review can reorder high/mid/low inside a tier", () => {
  const manager = new TierListEventManager();
  const state = manager.start(
    assignStatisticalBands(syntheticDossierDrafts(3))
  );
  state.unplacedPlayerIds = [];
  manager.commitPlacement(placement("p1", "POne", "B", 90, "medium"));
  manager.commitPlacement(placement("p2", "PTwo", "B", 80, "medium"));

  manager.applyFinalReviewRevisions("B", [
    {
      playerId: "p1",
      tier: "B",
      position: "low",
      reasoning:
        "Still belongs here but should sit below the other B reference.",
      confidence: "medium",
    },
    {
      playerId: "p2",
      tier: "B",
      position: "high",
      reasoning: "Better current comparison against this tier's player group.",
      confidence: "medium",
    },
  ]);

  assert(
    state.placed.B[0].playerId === "p2",
    "High B should sort above low B after final review"
  );
});

test("Tier-list final review can move adjacent tiers without duplication", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = { image: { enabled: false } };
  const command = new TierListCommand() as any;
  const state = command.manager.start(
    assignStatisticalBands(syntheticDossierDrafts(3))
  );
  state.unplacedPlayerIds = [];
  state.finalReviewTierIndex = 2;
  const original = placement("p1", "POne", "B", 90, "medium");
  original.position = "high";
  command.manager.commitPlacement(original);
  const payloads: any[] = [];
  command.tierJudge = {
    reviewFinalTier: async (payload: any) => {
      payloads.push(payload);
      return {
        source: "ollama",
        revisions: [
          {
            playerId: "p1",
            tier: "A",
            position: "low",
            reasoning: "Adjacent A boundary is a better evidence-based fit.",
            confidence: "medium",
          },
        ],
      };
    },
  };
  let posts = 0;
  command.postTierListImageSnapshot = async () => {
    posts += 1;
  };

  try {
    await command.final({
      deferReply: async () => {},
      editReply: async () => {},
      followUp: async () => ({ edit: async () => {} }),
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(state.phase === "final", "Final command should enter final phase");
  assert(state.placed.B.length === 0, "Moved player should leave old tier");
  assert(
    state.placed.A.length === 1,
    "Moved player should enter adjacent tier"
  );
  assert(
    state.placementHistory.length === 1,
    "Final review should not duplicate history entries"
  );
  assert(
    payloads.length === 1 && payloads[0].segment === "high",
    "Final review should call the judge for the non-empty segment only"
  );
  assert(
    posts === 4,
    "Final review should post one image per remaining tier from B through E"
  );
});

test("Tier-list final review prevents low-sample moves to S/A/E and requires context for B", () => {
  const manager = new TierListEventManager();
  const dossier = lowSampleDossier("final-low");
  const state = manager.start([dossier]);
  state.unplacedPlayerIds = [];
  manager.commitPlacement({
    playerId: dossier.playerId,
    displayName: dossier.displayName,
    tier: "C",
    position: "mid",
    reasoning: "Initial low-sample placement.",
    confidence: "low",
    score: dossier.score,
  });

  let applied = manager.applyFinalReviewRevisions("C", [
    {
      playerId: dossier.playerId,
      tier: "B",
      position: "mid",
      reasoning: "Model tried B without accepted context.",
      confidence: "medium",
    },
  ]);
  assert(applied[0].tier === "C", "Low-sample B should clamp without context");

  manager.addManualNote(
    dossier.playerId,
    "Reliable defender in organiser notes."
  );
  applied = manager.applyFinalReviewRevisions("C", [
    {
      playerId: dossier.playerId,
      tier: "B",
      position: "mid",
      reasoning: "Organiser context supports above-average team value.",
      confidence: "medium",
    },
  ]);
  assert(
    applied[0].tier === "B",
    "Low-sample B should be allowed with context"
  );

  applied = manager.applyFinalReviewRevisions("B", [
    {
      playerId: dossier.playerId,
      tier: "A",
      position: "low",
      reasoning: "Model tried an unavailable high tier despite low sample.",
      confidence: "medium",
    },
  ]);
  assert(applied[0].tier === "B", "Low-sample S/A/E should remain unavailable");
});

test("Tier-list final review skips empty segments and reports failed segments", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = { image: { enabled: false } };
  const command = new TierListCommand() as any;
  const state = command.manager.start(
    assignStatisticalBands(syntheticDossierDrafts(3))
  );
  state.unplacedPlayerIds = [];
  state.finalReviewTierIndex = 2;
  const high = placement("p1", "POne", "B", 90, "medium");
  high.position = "high";
  command.manager.commitPlacement(high);
  const segments: string[] = [];
  const payloads: any[] = [];
  command.tierJudge = {
    reviewFinalTier: async (payload: any) => {
      segments.push(payload.segment);
      payloads.push(payload);
      return { source: "fallback", reason: "model timeout" };
    },
  };
  const sentPayloads: any[] = [];
  command.postTierListImageSnapshot = async () => {};

  try {
    await command.final({
      deferReply: async () => {},
      editReply: async (payload: any) => {
        sentPayloads.push(payload);
      },
      followUp: async (payload: any) => {
        sentPayloads.push(payload);
        return {
          edit: async (edited: any) => {
            sentPayloads.push(edited);
          },
        };
      },
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    segments.length === 1 && segments[0] === "high",
    "Empty mid/low segments should be skipped"
  );
  assert(
    payloads[0].players.length === 1,
    "Segment call should include only players from that segment"
  );
  assert(
    state.placed.B[0].playerId === "p1" &&
      state.placed.B[0].position === "high",
    "Failed segment should keep existing placement unchanged"
  );
  assert(
    sentPayloads.some((payload) =>
      payload.embeds?.[0]?.toJSON().title.startsWith("🤖 AI Verdict: B tier")
    ),
    "Tier summary should use the AI verdict format"
  );
  assert(
    !JSON.stringify(sentPayloads).includes("placements reviewed"),
    "Tier summary should avoid operational completion copy"
  );
});

test("Tier-list final command announces the phase switch clearly", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = { image: { enabled: false } };
  const command = new TierListCommand() as any;
  const state = command.manager.start(
    assignStatisticalBands(syntheticDossierDrafts(2))
  );
  state.unplacedPlayerIds = [];
  const payloads: any[] = [];

  try {
    await command.final({
      deferReply: async () => {},
      editReply: async (payload: any) => {
        payloads.push(payload);
      },
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  const finalPayload = payloads.at(-1);
  const rendered = JSON.stringify(finalPayload);
  assert(
    finalPayload.content.includes("Phase change") &&
      finalPayload.content.includes("Switching to final review"),
    "Final command should explicitly announce the phase transition"
  );
  assert(
    rendered.includes("Final review started"),
    "Final review embed should show that the final phase started"
  );
});

test("Tier-list final command labels the completed final image", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = { image: { enabled: false } };
  const command = new TierListCommand() as any;
  const state = command.manager.start(
    assignStatisticalBands(syntheticDossierDrafts(2))
  );
  state.unplacedPlayerIds = [];
  state.phase = "final";
  state.finalReviewTierIndex = 5;
  let snapshotContent: string | undefined;
  command.postTierListImageSnapshot = async (
    _interaction: unknown,
    content?: string
  ) => {
    snapshotContent = content;
  };

  try {
    await command.final({
      deferReply: async () => {},
      editReply: async () => {},
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    snapshotContent?.includes("Final tier list complete") &&
      snapshotContent.includes("Full list"),
    "Completed final review should label the final snapshot image"
  );
});

test("Tier-list final command posts one final verdict using reviewed placements", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = { image: { enabled: false } };
  const command = new TierListCommand() as any;
  const state = command.manager.start(
    assignStatisticalBands(syntheticDossierDrafts(3))
  );
  state.unplacedPlayerIds = [];
  state.finalReviewTierIndex = 2;
  const original = placement("p1", "_Moved*Player", "B", 90, "medium");
  original.position = "high";
  command.manager.commitPlacement(original);
  let verdictPayload: any;
  command.tierJudge = {
    reviewFinalTier: async (payload: any) => ({
      source: "ollama",
      revisions: payload.players.map((player: any) => ({
        playerId: player.playerId,
        tier: "A",
        position: "low",
        reasoning: "Adjacent A boundary is a better evidence-based fit.",
        confidence: "high",
      })),
    }),
    finalVerdict: async (payload: any) => {
      verdictPayload = payload;
      return {
        source: "ollama",
        verdict: {
          S: "_Model* S commentary is safely escaped.",
          A: "_Moved*Player now appears in reviewed A.",
          B: "B tier is empty after final review.",
          C: "C tier is empty after final review.",
          D: "D tier is empty after final review.",
          E: "E tier is empty after final review.",
          overall: "_Overall* verdict uses final reviewed placements.",
        },
      };
    },
  };
  command.postTierListImageSnapshot = async () => {};
  const sentPayloads: any[] = [];

  try {
    await command.final({
      deferReply: async () => {},
      editReply: async () => {},
      followUp: async () => ({ edit: async () => {} }),
      channel: {
        isTextBased: () => true,
        send: async (payload: any) => {
          sentPayloads.push(payload);
          return {};
        },
      },
    });
  } finally {
    config.tierList = originalTierList;
  }

  const finalVerdicts = sentPayloads.filter(
    (payload) => payload.embeds?.[0]?.toJSON().title === "Final AI Verdict"
  );
  assert(finalVerdicts.length === 1, "Final should post one final verdict");
  assert(
    verdictPayload.tiers.A.some((player: any) => player.playerId === "p1"),
    "Final verdict payload should use reviewed placements"
  );
  assert(
    !verdictPayload.tiers.B.some((player: any) => player.playerId === "p1"),
    "Final verdict payload should not use provisional order"
  );
  assert(
    JSON.stringify(finalVerdicts[0].embeds[0].toJSON()).includes("\\_Overall"),
    "Final verdict text should escape Discord markdown"
  );
});

test("Tier-list final verdict falls back without failing completion", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = { image: { enabled: false } };
  const command = new TierListCommand() as any;
  const state = command.manager.start(
    assignStatisticalBands(syntheticDossierDrafts(2))
  );
  state.unplacedPlayerIds = [];
  state.finalReviewTierIndex = 2;
  const original = placement("p1", "FallbackPlayer", "B", 90, "medium");
  original.position = "high";
  command.manager.commitPlacement(original);
  command.tierJudge = {
    reviewFinalTier: async (payload: any) => ({
      source: "ollama",
      revisions: payload.players.map((player: any) => ({
        playerId: player.playerId,
        tier: player.tier,
        position: player.position,
        reasoning: player.reasoning,
        confidence: player.confidence,
      })),
    }),
    finalVerdict: async () => ({
      source: "fallback",
      reason: "Ollama failed: invalid JSON",
    }),
  };
  command.postTierListImageSnapshot = async () => {};
  const sentPayloads: any[] = [];

  try {
    await command.final({
      deferReply: async () => {},
      editReply: async () => {},
      followUp: async () => ({ edit: async () => {} }),
      channel: {
        isTextBased: () => true,
        send: async (payload: any) => {
          sentPayloads.push(payload);
          return {};
        },
      },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    state.finalReviewedTiers.includes("E"),
    "Fallback verdict should not stop final review completion"
  );
  assert(
    sentPayloads.some((payload) =>
      payload.embeds?.[0]
        ?.toJSON()
        .description.includes("Deterministic fallback used")
    ),
    "Fallback final verdict should be posted"
  );
});

test("Tier-list final image rows can exclude limited-sample players", () => {
  const command = new TierListCommand() as any;
  const limited = lowSampleDossier("limited");
  limited.displayName = "LimitedPlayer";
  const steady = lowSampleDossier("steady");
  steady.displayName = "SteadyPlayer";
  steady.limitedSample = false;
  steady.gamesPlayed = 12;
  const state = command.manager.start([limited, steady]);
  state.unplacedPlayerIds = [];
  command.manager.commitPlacement(
    placement("limited", "LimitedPlayer", "C", 50, "medium")
  );
  command.manager.commitPlacement(
    placement("steady", "SteadyPlayer", "C", 60, "medium")
  );

  const rows = command.buildTierListImageRows({ excludeLimitedSample: true });

  assert(
    rows.C.length === 1 && rows.C[0].displayName === "SteadyPlayer",
    "Filtered rows should remove limited-sample players and keep others in tier"
  );
});

test("Tier-list final completion posts full and confidence-filtered images", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    image: {
      enabled: true,
      width: 240,
      labelColumnWidth: 70,
      baseRowHeight: 80,
      cellSize: 32,
      gap: 6,
      padding: 6,
      fontSize: 10,
      minFontSize: 8,
      maxImageHeight: 1000,
    },
  };
  const command = new TierListCommand() as any;
  const limited = lowSampleDossier("limited-final");
  limited.displayName = "LimitedFinal";
  const steady = lowSampleDossier("steady-final");
  steady.displayName = "SteadyFinal";
  steady.limitedSample = false;
  steady.gamesPlayed = 12;
  const state = command.manager.start([limited, steady]);
  state.unplacedPlayerIds = [];
  command.manager.commitPlacement(
    placement("limited-final", "LimitedFinal", "C", 50, "medium")
  );
  command.manager.commitPlacement(
    placement("steady-final", "SteadyFinal", "C", 60, "medium")
  );
  const sent: any[] = [];

  try {
    await command.postTierListImageSnapshot(
      {
        guild: {
          channels: {
            fetch: async () => ({
              isTextBased: () => true,
              send: async (payload: any) => {
                sent.push(payload);
                return { id: `message-${sent.length}` };
              },
            }),
          },
        },
        channel: { isTextBased: () => false },
      },
      "Final tier list complete. Full list:"
    );
  } finally {
    config.tierList = originalTierList;
  }

  const imagePosts = sent.filter((payload) => payload.files?.length);
  assert(imagePosts.length === 2, "Final completion should post two images");
  assert(
    imagePosts[0].content === "Final tier list complete. Full list:",
    "First final image should use the full-list caption"
  );
  assert(
    imagePosts[1].content ===
      "Confidence-filtered final tier list. Limited-data players removed:",
    "Second final image should use the filtered-list caption"
  );
  assert(
    imagePosts[1].files[0].attachment.length <
      imagePosts[0].files[0].attachment.length,
    "Filtered image should render fewer players than the full image"
  );
});

test("Tier-list final completion skips filtered image when no limited-sample players exist", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    image: {
      enabled: true,
      width: 240,
      labelColumnWidth: 70,
      baseRowHeight: 80,
      cellSize: 32,
      gap: 6,
      padding: 6,
      fontSize: 10,
      minFontSize: 8,
      maxImageHeight: 1000,
    },
  };
  const command = new TierListCommand() as any;
  const steady = lowSampleDossier("steady-only");
  steady.displayName = "SteadyOnly";
  steady.limitedSample = false;
  steady.gamesPlayed = 12;
  const state = command.manager.start([steady]);
  state.unplacedPlayerIds = [];
  command.manager.commitPlacement(
    placement("steady-only", "SteadyOnly", "C", 60, "medium")
  );
  const sent: any[] = [];

  try {
    await command.postTierListImageSnapshot(
      {
        guild: {
          channels: {
            fetch: async () => ({
              isTextBased: () => true,
              send: async (payload: any) => {
                sent.push(payload);
                return { id: `message-${sent.length}` };
              },
            }),
          },
        },
        channel: { isTextBased: () => false },
      },
      "Final tier list complete. Full list:"
    );
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    sent.filter((payload) => payload.files?.length).length === 1,
    "Only the full final image should be posted when filtering changes nothing"
  );
  assert(
    sent.some((payload) =>
      payload.content?.includes("no limited-data players were removed")
    ),
    "Final completion should mention that no limited-data players were removed"
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

test("Tier-list manager pause clears the active question timeout", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timerHandle = { cleared: false };
  (global as any).setTimeout = () => timerHandle;
  (global as any).clearTimeout = (handle: any) => {
    handle.cleared = true;
  };

  try {
    const dossiers = buildAllSeasonTierDossiers(fixture());
    const manager = new TierListEventManager();
    manager.start(dossiers);
    const promise = manager.beginQuestion(dossiers[0], "questions", 10000, 5);
    const paused = manager.pauseQuestion();
    const pausedAgain = manager.pauseQuestion();

    assert(!!paused, "Pause should return the active question session");
    assert(paused?.paused === true, "Question session should be marked paused");
    assert(paused?.timer === null, "Paused question should not keep a timer");
    assert(timerHandle.cleared, "Pause should clear the active timeout");
    assert(
      pausedAgain?.timer === null,
      "Pausing an already paused question should stay idempotent"
    );

    manager.finishQuestion("discard", 5);
    await promise;
  } finally {
    (global as any).setTimeout = originalSetTimeout as any;
    (global as any).clearTimeout = originalClearTimeout as any;
  }
});

test("Tier-list manager continues a paused question with collected answers", async () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const manager = new TierListEventManager();
  manager.start(dossiers);
  const promise = manager.beginQuestion(dossiers[0], "questions", 10000, 5);

  manager.pauseQuestion();
  manager.handleMessage(
    fakeMessage(
      "questions",
      "u1",
      "Reliable defender who keeps comms clear and rotates quickly."
    )
  );
  manager.finishQuestion("continue", 5);

  const result = await promise;
  assert(result.action === "continue", "Paused question should continue");
  assert(
    result.notes.accepted.length === 1,
    "Continue should keep accepted notes from paused questions"
  );
});

test("Tier-list manager discard and skip resolve paused questions safely", async () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const manager = new TierListEventManager();
  manager.start(dossiers);
  const discardPromise = manager.beginQuestion(
    dossiers[0],
    "questions",
    10000,
    5
  );
  manager.pauseQuestion();
  manager.finishQuestion("discard", 5);
  const discardResult = await discardPromise;

  const skipPromise = manager.beginQuestion(dossiers[1], "questions", 10000, 5);
  manager.pauseQuestion();
  manager.finishQuestion("skip", 5);
  const skipResult = await skipPromise;

  assert(discardResult.action === "discard", "Discard should resolve paused");
  assert(skipResult.action === "skip", "Skip should resolve paused");
  assert(
    manager.getActiveQuestion() === null,
    "Paused question should clear after resolving"
  );
});

test("Tier-list manager reroll keeps paused question paused", async () => {
  const dossiers = buildAllSeasonTierDossiers(fixture());
  const manager = new TierListEventManager();
  manager.start(dossiers);
  const promise = manager.beginQuestion(dossiers[0], "questions", 10000, 5);
  const firstQuestion = manager.getActiveQuestion()?.question;

  manager.pauseQuestion();
  const rerolled = manager.rerollQuestion();
  const session = manager.getActiveQuestion();

  assert(!!rerolled, "Reroll should update the active question");
  assert(rerolled !== firstQuestion, "Reroll should change question text");
  assert(session?.paused === true, "Reroll should keep the question paused");
  assert(session?.timer === null, "Reroll should not restart a paused timer");

  manager.finishQuestion("discard", 5);
  await promise;
});

test("Consistency pass suggests small moves without rewriting the whole list", () => {
  const state: TierListState = {
    eventId: "test",
    createdAt: new Date(),
    phase: "provisional",
    finalReviewTierIndex: 0,
    finalReviewedTiers: [],
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
    anchorPlayerIds: [],
    activeAnchorIndex: 0,
    anchorVotesByPlayerId: {},
    postedImageMessageIds: [],
    paused: false,
    placementReviewsByPlayerId: {},
  };

  const suggestions = suggestConsistencyMoves(state);
  assert(suggestions.length === 1, "Should suggest one small consistency move");
  assert(
    suggestions[0].suggestion.includes("low A"),
    "Suggestion should be bounded to a nearby tier"
  );
});

test("Community answer filtering keeps short role signals and rejects spam", () => {
  const notes = filterCommunityAnswers([
    { userId: "1", content: "put them S tier" },
    { userId: "2", content: "lol" },
    { userId: "3", content: "Defender/Farmer" },
    { userId: "3", content: "flex" },
    { userId: "4", content: "Defender/Farmer" },
    { userId: "5", content: "trash defender" },
    { userId: "6", content: "specialist rusher" },
    { userId: "7", content: "shotcaller" },
    { userId: "8", content: "goat" },
  ]);

  assert(notes.accepted.length === 3, "Should keep short useful notes");
  assert(
    notes.accepted.includes("Defender/Farmer"),
    "Should accept slash-separated role answers"
  );
  assert(
    notes.accepted.includes("specialist rusher") &&
      notes.accepted.includes("shotcaller"),
    "Should accept short specialist and playstyle answers"
  );
  assert(
    notes.rejected.some((item) => item.reason === "direct tier command"),
    "Should reject direct tier commands"
  );
  assert(
    notes.rejected.some((item) => item.reason === "duplicate user"),
    "Should reject duplicate users"
  );
  assert(
    notes.rejected.some((item) => item.reason === "duplicate answer"),
    "Should reject duplicate answers"
  );
  assert(
    notes.rejected.some((item) => item.reason === "low relevance or insult"),
    "Should reject insults and meme-only answers"
  );
  assert(
    notes.summary?.includes("defender") &&
      notes.summary.includes("farmer") &&
      notes.summary.includes("shotcaller"),
    "Summary should include detected role and playstyle themes"
  );
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

test("Ollama final review parser accepts wrapped revision arrays", () => {
  const parsed = parseFinalReviewResponse(
    JSON.stringify({
      revisions: [
        {
          playerId: "p1",
          tier: "S",
          position: "high",
          reasoning:
            "Strong evidence keeps this player near the top of the selected segment.",
          confidence: "high",
        },
      ],
    })
  );

  assert(parsed.length === 1, "Wrapped revisions should parse");
  assert(parsed[0].playerId === "p1", "Revision player id should survive");
  assert(parsed[0].tier === "S", "Revision tier should parse");
});

test("Ollama final review parser accepts a single revision object", () => {
  const parsed = parseFinalReviewResponse(
    JSON.stringify({
      playerId: "p2",
      tier: "A",
      position: "low",
      reasoning:
        "Adjacent boundary comparison shows this player still belongs in the returned tier.",
      confidence: "medium",
    })
  );

  assert(parsed.length === 1, "Single object should parse as one revision");
  assert(parsed[0].playerId === "p2", "Single revision should keep player id");
});

test("Ollama final verdict parser accepts tier-by-tier JSON", () => {
  const parsed = parseFinalVerdictResponse(
    JSON.stringify({
      S: "S tier is tiny and reserved for the clearest outlier evidence.",
      A: "A tier has high-confidence players with strong evidence profiles.",
      B: "B tier is above average with generally stable reviewed placements.",
      C: "C tier is the broad community-average band with mixed profiles.",
      D: "D tier contains weaker or less stable evidence profiles.",
      E: "E tier is the bottom band where risk outweighs positive signals.",
      overall:
        "The overall list is commentary only and describes final reviewed placements.",
    })
  );

  assert(parsed.S.includes("tiny"), "S verdict should parse");
  assert(parsed.overall.includes("commentary"), "Overall verdict should parse");
});

test("Ollama final verdict parser rejects missing or non-string keys", () => {
  let missingRejected = false;
  try {
    parseFinalVerdictResponse(
      JSON.stringify({
        S: "S tier has enough valid text to pass this field.",
        A: "A tier has enough valid text to pass this field.",
        B: "B tier has enough valid text to pass this field.",
        C: "C tier has enough valid text to pass this field.",
        D: "D tier has enough valid text to pass this field.",
        overall: "Overall has enough valid text to pass this field.",
      })
    );
  } catch (error) {
    void error;
    missingRejected = true;
  }

  let typeRejected = false;
  try {
    parseFinalVerdictResponse(
      JSON.stringify({
        S: "S tier has enough valid text to pass this field.",
        A: 123,
        B: "B tier has enough valid text to pass this field.",
        C: "C tier has enough valid text to pass this field.",
        D: "D tier has enough valid text to pass this field.",
        E: "E tier has enough valid text to pass this field.",
        overall: "Overall has enough valid text to pass this field.",
      })
    );
  } catch (error) {
    void error;
    typeRejected = true;
  }

  assert(missingRejected, "Missing tier verdict should be rejected");
  assert(typeRejected, "Non-string tier verdict should be rejected");
});

test("Ollama final verdict parser trims and caps long output", () => {
  const long = ` ${"x".repeat(1200)} `;
  const parsed = parseFinalVerdictResponse(
    JSON.stringify({
      S: long,
      A: long,
      B: long,
      C: long,
      D: long,
      E: long,
      overall: long,
    })
  );

  assert(parsed.S.length === 900, "Tier verdict should be capped");
  assert(parsed.overall.length === 900, "Overall verdict should be capped");
  assert(!parsed.S.startsWith(" "), "Tier verdict should be trimmed first");
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
  let requestedBody = {} as {
    model?: string;
    options?: { temperature?: number };
  };
  config.llm = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      options?: { temperature?: number };
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
        lastPlayedAt: new Date(),
        provisional: false,
        limitedSample: false,
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
          mvpEligibleGames: 12,
          mvpRate: 0.08,
          smoothedMvpRate: 0.08,
          captainEligibleGames: 11,
          captainRate: 0,
          captainGames: 0,
          captainWins: 0,
          captainWinRate: null,
          smoothedCaptainWinRate: null,
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
    assert(
      requestedBody.options?.temperature === 0,
      "Judge should default Ollama temperature to zero"
    );
  } finally {
    globalThis.fetch = originalFetch;
    config.llm = originalLlm;
  }
});

test("Ollama final review retries once after a transient failed call", async () => {
  const config = ConfigManager.getConfig();
  const originalLlm = config.llm;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  config.llm = undefined;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) throw new Error("This operation was aborted");
    return new Response(
      JSON.stringify({
        message: {
          content: JSON.stringify([
            {
              playerId: "retry-player",
              tier: "C",
              position: "mid",
              confidence: "medium",
              reasoning:
                "The retry response keeps the player in mid C based on comparable evidence.",
            },
          ]),
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const result = await new OllamaTierJudge().reviewFinalTier({
      tier: "C",
      segment: "mid",
      players: [
        {
          playerId: "retry-player",
          displayName: "RetryPlayer",
          tier: "C",
          position: "mid",
          score: 50,
          confidence: "medium",
          statisticalBand: "C",
          gamesPlayed: 10,
          limitedSample: false,
          reasoning: "Existing placement reasoning for retry player.",
          objectiveSummary: "Retry player has average all-season context.",
          statContext: {
            record: "5-5",
            adjustedWinScore: 0.5,
            mvpCount: 0,
            mvpEligibleGames: 10,
            mvpRate: 0,
            captainEligibleGames: 10,
            captainRate: 0,
            captainGames: 0,
            captainWins: 0,
            captainWinRate: null,
            averageElo: 1000,
            averageSeasonEloPercentile: 0.5,
          },
        },
      ],
      sameTierReferences: {},
      adjacentReferences: {},
      currentTierList: { S: [], A: [], B: [], C: [], D: [], E: [] },
      instructions: [],
    });

    assert(calls === 2, "Final review should retry after one failed call");
    assert(result.source === "ollama", "Retry success should use Ollama");
    assert(
      result.source === "ollama" && result.revisions.length === 1,
      "Retry response should be parsed"
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
        lastPlayedAt: new Date(),
        provisional: true,
        limitedSample: true,
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
          mvpEligibleGames: 1,
          mvpRate: 0,
          smoothedMvpRate: 0,
          captainEligibleGames: 1,
          captainRate: 0,
          captainGames: 0,
          captainWins: 0,
          captainWinRate: null,
          smoothedCaptainWinRate: null,
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

test("Tier-list image names dynamically shrink before they exceed cell width", () => {
  const fitted = fitTierListName(
    "VeryLongMinecraftUsernameThatWillNotFit",
    72,
    16,
    10
  );

  assert(
    fitted.text === "VeryLongMinecraftUsernameThatWillNotFit",
    "Long names should keep the full text"
  );
  assert(fitted.fontSize < 16, "Long names should use a smaller font size");
  assert(!fitted.text.includes("…"), "Long names should not use ellipsis");
});

test("Tier-list image names keep base size when they already fit", () => {
  const fitted = fitTierListName("ShortName", 120, 16, 10);

  assert(fitted.text === "ShortName", "Normal names should keep full text");
  assert(fitted.fontSize === 16, "Normal names should keep base font size");
  assert(!fitted.textLength, "Normal names should not need forced SVG fit");
});

test("Tier-list image layout force-fits extreme names without ellipsis", () => {
  const rows = emptyTierListImageRows();
  rows.S = [
    {
      displayName:
        "ExtremelyLongMinecraftUsernameThatStillNeedsToRemainReadable",
    },
  ];
  const layout = calculateTierListImageLayout(rows, {
    width: 240,
    labelColumnWidth: 70,
    baseRowHeight: 80,
    cellSize: 48,
    gap: 8,
    padding: 8,
    fontSize: 16,
    minFontSize: 10,
    maxImageHeight: 1000,
  });
  const player = layout.pages[0].rows.find((row) => row.tier === "S")
    ?.players[0];

  assert(!!player, "Extreme name player should be laid out");
  assert(
    player!.text ===
      "ExtremelyLongMinecraftUsernameThatStillNeedsToRemainReadable",
    "Extreme names should keep the full text"
  );
  assert(player!.fontSize === 10, "Extreme names should use min font size");
  assert(
    player!.textLength === 48,
    "Extreme names should use SVG textLength as the final fit guard"
  );
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

test("Tier-list Discord verdicts escape display names without changing image rows", () => {
  const command = new TierListCommand() as any;
  const dossier = lowSampleDossier("_Bold*Name|`>Test");
  const state = command.manager.start([dossier]);
  const placementValue: TierPlacement = {
    playerId: dossier.playerId,
    displayName: dossier.displayName,
    tier: "C",
    position: "mid",
    reasoning:
      "_Bold*Name|`>Test has average comparable evidence and should stay in C.",
    confidence: "medium",
    score: dossier.score,
  };
  command.manager.commitPlacement(placementValue);

  const verdict = command.placementEmbed(placementValue, "Ollama").toJSON();
  const rows = command.buildTierListImageRows();

  assert(
    verdict.title?.includes(escapeText(dossier.displayName)),
    "Verdict title should escape markdown-sensitive display names"
  );
  assert(
    verdict.description?.includes(escapeText(dossier.displayName)),
    "Verdict reasoning should escape markdown-sensitive display names"
  );
  assert(
    command.currentStateText().includes(escapeText(dossier.displayName)),
    "Text summaries should escape markdown-sensitive display names"
  );
  assert(
    rows.C[0].displayName === dossier.displayName &&
      rows.C[0].headIdentifier === dossier.displayName,
    "Image rows should keep the raw display name"
  );
  assert(state.placementCount === 1, "Fixture should commit one placement");
});

test("Tier-list verdict display normalizes previously escaped names", () => {
  const command = new TierListCommand() as any;
  const dossier = lowSampleDossier("oak_sapling\\\\_");
  const state = command.manager.start([dossier]);
  const placementValue: TierPlacement = {
    playerId: dossier.playerId,
    displayName: dossier.displayName,
    tier: "C",
    position: "mid",
    reasoning: "oak_sapling\\\\_ is a limited sample player who belongs in C.",
    confidence: "medium",
    score: dossier.score,
  };
  command.manager.commitPlacement(placementValue);

  const verdict = command.placementEmbed(placementValue, "Ollama").toJSON();

  assert(
    verdict.title?.includes("oak\\_sapling\\_"),
    "Verdict title should show one escaped underscore"
  );
  assert(
    !verdict.title?.includes("\\\\\\\\_"),
    "Verdict title should not leak doubled escape slashes"
  );
  assert(
    verdict.description?.includes("oak\\_sapling\\_"),
    "Verdict reasoning should show one escaped underscore"
  );
  assert(
    !verdict.description?.includes("\\\\\\\\_"),
    "Verdict reasoning should not leak doubled escape slashes"
  );
  assert(state.placementCount === 1, "Fixture should commit one placement");
});

test("Tier-list next edits processing payloads into styled verdicts", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: false },
    autoAdvanceSeconds: 0,
  };
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 2);
  command.manager.start(dossiers);
  command.tierJudge = judgeForPayload();
  const payloads: any[] = [];

  try {
    await command.next({
      options: { getInteger: () => 2 },
      deferReply: async () => {},
      editReply: async (payload: any) => {
        payloads.push(payload);
      },
      followUp: async (payload: any) => {
        payloads.push(payload);
      },
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  const placementPayloads = payloads.filter((payload) => payload.embeds);
  assert(
    placementPayloads.length === 4,
    "Two placements should emit processing and verdict payloads"
  );
  assert(
    placementPayloads.every((payload) => payload.embeds?.length === 1),
    "Each placement update should be a styled embed"
  );
  assert(
    placementPayloads[0].embeds[0].toJSON().title.startsWith("🤖 Reviewing "),
    "Placement should show an immediate processing embed"
  );
  const verdict = placementPayloads[1].embeds[0].toJSON();
  const renderedVerdict = JSON.stringify(verdict);
  assert(
    verdict.title.startsWith("🤖 AI Verdict: "),
    "Final placement should use the AI verdict title"
  );
  assert(
    verdict.description.startsWith("> "),
    "Final placement should format reasoning like a speech bubble"
  );
  assert(
    !renderedVerdict.includes("Source") &&
      !renderedVerdict.includes("Snapshot") &&
      !renderedVerdict.includes("Skipped") &&
      !renderedVerdict.includes("Unplaced"),
    "Final placement embed should omit internal/source/snapshot fields"
  );
  assert(
    !payloads.some((payload) =>
      JSON.stringify(payload).includes("Live tier list")
    ),
    "Placement output should not include duplicate live state blocks"
  );
  assert(
    payloads.some((payload) =>
      payload.content?.includes("Provisional placement is complete")
    ),
    "Final provisional placement should tell organisers to start final review"
  );
});

test("Tier-list provisional completion handoff does not silently stop", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: false },
    autoAdvanceSeconds: 0,
  };
  const command = new TierListCommand() as any;
  command.manager.start(buildAllSeasonTierDossiers(fixture()).slice(0, 1));
  command.tierJudge = judgeForPayload();
  let handoff = "";

  try {
    await command.next({
      options: { getInteger: () => 1 },
      deferReply: async () => {},
      editReply: async () => {},
      followUp: async (payload: any) => {
        if (payload.content) handoff = payload.content;
      },
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    command.manager.getState().unplacedPlayerIds.length === 0,
    "Fixture should complete provisional placement"
  );
  assert(
    command.manager.getState().phase === "provisional",
    "Final review should still require the organiser command"
  );
  assert(
    handoff.includes("/tierlist final"),
    "Completion handoff should name the final command"
  );
});

test("Tier-list final provisional placement leaves no active placement controls", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: false },
    autoAdvanceSeconds: 0,
  };
  const command = new TierListCommand() as any;
  command.manager.start(buildAllSeasonTierDossiers(fixture()).slice(0, 1));
  command.tierJudge = judgeForPayload();
  const payloads: any[] = [];

  try {
    await command.next({
      options: { getInteger: () => 1 },
      deferReply: async () => {},
      editReply: async (payload: any) => {
        payloads.push(payload);
      },
      followUp: async (payload: any) => {
        payloads.push(payload);
      },
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  const verdict = payloads.find((payload) =>
    payload.embeds?.[0]?.toJSON().title.startsWith("🤖 AI Verdict: ")
  );
  assert(!!verdict, "Final placement verdict should be sent");
  assert(
    !hasComponent(verdict, "tierlist:placement-next"),
    "Final placement verdict should not keep a Next player button"
  );
  assert(
    !hasComponent(verdict, "tierlist:placement-pause") &&
      !hasComponent(verdict, "tierlist:placement-rerate"),
    "Final placement verdict should not keep active placement controls"
  );
  assert(
    payloads.some((payload) => payload.content?.includes("/tierlist final")),
    "Final placement should still post the final-review handoff"
  );
});

test("Tier-list next button places the next player", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: false },
    autoAdvanceSeconds: 0,
  };
  const command = new TierListCommand() as any;
  command.manager.start(buildAllSeasonTierDossiers(fixture()).slice(0, 2));
  command.tierJudge = judgeForPayload();
  const payloads: any[] = [];

  try {
    await command.handleButtonPress({
      customId: "tierlist:placement-next",
      guild: {},
      member: { roles: { cache: { has: () => true } } },
      channel: { isTextBased: () => false },
      deferUpdate: async () => {},
      followUp: async (payload: any) => {
        payloads.push(payload);
      },
    } as any);
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    command.manager.getState().placementCount === 1,
    "Next button should place one player"
  );
  assert(
    payloads[0].embeds[0].toJSON().title.startsWith("🤖 Reviewing "),
    "Next button should emit a processing embed"
  );
  assert(
    payloads[1].embeds[0].toJSON().title.startsWith("🤖 AI Verdict: "),
    "Next button should emit a verdict embed"
  );
});

test("Tier-list next button on final player leaves no useless controls", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: false },
    autoAdvanceSeconds: 0,
  };
  const command = new TierListCommand() as any;
  command.manager.start(buildAllSeasonTierDossiers(fixture()).slice(0, 1));
  command.tierJudge = judgeForPayload();
  const payloads: any[] = [];

  try {
    await command.handleButtonPress({
      customId: "tierlist:placement-next",
      guild: {},
      member: { roles: { cache: { has: () => true } } },
      channel: { isTextBased: () => false },
      deferUpdate: async () => {},
      followUp: async (payload: any) => {
        payloads.push(payload);
      },
    } as any);
  } finally {
    config.tierList = originalTierList;
  }

  const verdict = payloads.find((payload) =>
    payload.embeds?.[0]?.toJSON().title.startsWith("🤖 AI Verdict: ")
  );
  assert(!!verdict, "Final button placement verdict should be sent");
  assert(
    !hasComponent(verdict, "tierlist:placement-next"),
    "Final button placement should not include a Next player button"
  );
  assert(
    payloads.some((payload) => payload.content?.includes("/tierlist final")),
    "Final button placement should still post the final-review handoff"
  );
});

test("Tier-list provisional snapshots post every 5 placements", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: true },
    autoAdvanceSeconds: 0,
  };
  const command = new TierListCommand() as any;
  command.manager.start(
    Array.from({ length: 21 }, (_, index) => lowSampleDossier(`snap-${index}`))
  );
  command.tierJudge = judgeForPayload();
  let snapshots = 0;
  command.postTierListImageSnapshot = async () => {
    snapshots += 1;
  };

  try {
    await command.next({
      options: { getInteger: () => 4 },
      deferReply: async () => {},
      editReply: async () => ({}),
      followUp: async () => ({}),
      channel: { isTextBased: () => false },
    });
    assert(snapshots === 0, "Placements 1-4 should not post snapshots");

    await command.next({
      options: { getInteger: () => 1 },
      deferReply: async () => {},
      editReply: async () => ({}),
      followUp: async () => ({}),
      channel: { isTextBased: () => false },
    });
    assert(snapshots === 1, "Placement 5 should post a snapshot");

    await command.next({
      options: { getInteger: () => 5 },
      deferReply: async () => {},
      editReply: async () => ({}),
      followUp: async () => ({}),
      channel: { isTextBased: () => false },
    });
    assert(snapshots === 2, "Placement 10 should post a snapshot");
  } finally {
    config.tierList = originalTierList;
  }
});

test("Tier-list fast mode places all players, skips live prompts, and posts final snapshot once", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: true,
    image: { enabled: true },
    autoAdvanceSeconds: 1,
  };
  const command = new TierListCommand() as any;
  command.loadDossiers = async () =>
    buildAllSeasonTierDossiers(fixture()).slice(0, 3);
  let communityQuestions = 0;
  command.collectCommunityNotes = async () => {
    communityQuestions += 1;
    return null;
  };
  let snapshots = 0;
  const snapshotMessages: Array<string | undefined> = [];
  command.postTierListImageSnapshot = async (
    _interaction: any,
    content?: string
  ) => {
    snapshots += 1;
    snapshotMessages.push(content);
  };
  command.tierJudge = judgeForPayload();
  command.tierJudge.reviewFinalTier = async (payload: any) => ({
    source: "ollama",
    revisions: payload.players.map((player: any) => ({
      playerId: player.playerId,
      tier: player.tier,
      position: player.position,
      reasoning: player.reasoning,
      confidence: player.confidence,
    })),
  });

  try {
    await command.start({
      options: {
        getInteger: () => null,
        getBoolean: (name: string) => name === "fast_mode",
      },
      deferReply: async () => {},
      editReply: async () => {},
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  const state = command.manager.getState();
  assert(state.fastMode, "Fast mode should be recorded in state");
  assert(
    state.unplacedPlayerIds.length === 0,
    "Fast mode should place every selected player"
  );
  assert(state.phase === "final", "Fast mode should enter final phase");
  assert(
    state.finalReviewedTiers.length === 6,
    "Fast mode should complete final review"
  );
  assert(
    communityQuestions === 0,
    "Fast mode should not ask community questions"
  );
  assert(
    state.noCommunityInput === true,
    "Fast mode should implicitly disable community input"
  );
  assert(snapshots === 1, "Fast mode should only post the final snapshot set");
  assert(
    snapshotMessages[0] === "Final tier list complete. Full list:",
    "Fast mode should post final PNG output at completion"
  );
});

test("Tier-list no-community-input mode starts without anchors and hides rerate controls", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: true,
    askCommunityEveryNPlayers: 1,
    image: { enabled: false },
    autoAdvanceSeconds: 0,
  };
  const command = new TierListCommand() as any;
  command.loadDossiers = async () =>
    buildAllSeasonTierDossiers(fixture()).slice(0, 3);
  command.tierJudge = judgeForPayload();
  let communityQuestions = 0;
  command.sendQuestion = async () => {
    communityQuestions += 1;
    command.manager.finishQuestion(
      "discard",
      command.tierConfig().maxCommunityAnswers
    );
  };
  const payloads: any[] = [];

  try {
    await command.start({
      options: {
        getInteger: () => null,
        getBoolean: (name: string) => name === "no_community_input",
      },
      deferReply: async () => {},
      editReply: async (payload: any) => {
        payloads.push(payload);
        return { id: `edit-${payloads.length}` };
      },
      channel: { isTextBased: () => false },
    });

    const state = command.manager.getState();
    assert(
      state.noCommunityInput === true,
      "No-community-input mode should be recorded in state"
    );
    assert(
      state.anchorPlayerIds.length === 0,
      "No-community-input mode should not create anchor player IDs"
    );
    assert(
      state.phase === "provisional",
      "No-community-input mode should skip the anchor phase"
    );

    await command.next({
      options: { getInteger: () => 2 },
      deferReply: async () => {},
      editReply: async (payload: any) => {
        payloads.push(payload);
        return { id: `edit-${payloads.length}` };
      },
      followUp: async (payload: any) => {
        payloads.push(payload);
        return { id: `follow-${payloads.length}` };
      },
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    communityQuestions === 0,
    "No-community-input mode should not send community questions"
  );
  const placementPayload = payloads.find(
    (payload) =>
      hasComponent(payload, "tierlist:placement-next") &&
      hasComponent(payload, "tierlist:placement-pause")
  );
  assert(!!placementPayload, "Placement should include organiser controls");
  assert(
    !hasComponent(placementPayload, "tierlist:placement-rerate"),
    "No-community-input placement should hide rerate controls"
  );
  const placementFields =
    placementPayload.embeds?.[0]
      ?.toJSON()
      .fields?.map((field: any) => field.name) ?? [];
  assert(
    !placementFields.includes("Review"),
    "No-community-input placement should not show rerate review status"
  );
});

test("Tier-list no-community-input completion posts final reviews and final verdict", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: true,
    askCommunityEveryNPlayers: 1,
    image: { enabled: true },
    autoAdvanceSeconds: 0,
  };
  const command = new TierListCommand() as any;
  command.loadDossiers = async () =>
    buildAllSeasonTierDossiers(fixture()).slice(0, 2);
  command.tierJudge = judgeForPayload();
  command.tierJudge.reviewFinalTier = async (payload: any) => ({
    source: "ollama",
    revisions: payload.players.map((player: any) => ({
      playerId: player.playerId,
      tier: player.tier,
      position: player.position,
      reasoning: player.reasoning,
      confidence: player.confidence,
    })),
  });
  command.tierJudge.finalVerdict = async () => ({
    source: "ollama",
    verdict: {
      S: "S tier reviewed.",
      A: "A tier reviewed.",
      B: "B tier reviewed.",
      C: "C tier reviewed.",
      D: "D tier reviewed.",
      E: "E tier reviewed.",
      overall: "Overall final verdict posted.",
    },
  });
  let snapshots = 0;
  let snapshotContent: string | undefined;
  command.postTierListImageSnapshot = async (
    _interaction: any,
    content?: string
  ) => {
    snapshots += 1;
    snapshotContent = content;
  };
  const payloads: any[] = [];

  try {
    await command.start({
      options: {
        getInteger: () => null,
        getBoolean: (name: string) => name === "no_community_input",
      },
      deferReply: async () => {},
      editReply: async (payload: any) => {
        payloads.push(payload);
        return { id: `edit-${payloads.length}` };
      },
      channel: {
        isTextBased: () => true,
        send: async (payload: any) => {
          payloads.push(payload);
          return { id: `channel-${payloads.length}` };
        },
      },
    });

    await command.next({
      options: { getInteger: () => 2 },
      deferReply: async () => {},
      editReply: async (payload: any) => {
        payloads.push(payload);
        return { id: `edit-${payloads.length}` };
      },
      followUp: async () => {
        throw new Error("Invalid Webhook Token");
      },
      channel: {
        isTextBased: () => true,
        send: async (payload: any) => {
          payloads.push(payload);
          return { id: `channel-${payloads.length}` };
        },
      },
    });
  } finally {
    config.tierList = originalTierList;
  }

  const finalReviewPayloads = payloads.filter((payload) => {
    const title = payload.embeds?.[0]?.toJSON().title;
    return (
      typeof title === "string" && /^🤖 AI Verdict: [SABCDE] tier$/.test(title)
    );
  });
  assert(
    finalReviewPayloads.length === 6,
    "No-community-input completion should post one final review per tier"
  );
  assert(
    finalReviewPayloads.every(
      (payload) =>
        !payload.embeds?.[0]
          ?.toJSON()
          .description.includes("placements reviewed")
    ),
    "Final review messages should be commentary rather than completion reports"
  );
  assert(
    payloads.some(
      (payload) => payload.embeds?.[0]?.toJSON().title === "Final AI Verdict"
    ),
    "No-community-input completion should post the overall final verdict"
  );
  assert(
    command.manager.getState().phase === "final",
    "No-community-input completion should enter final phase"
  );
  assert(
    snapshots === 1 &&
      snapshotContent === "Final tier list complete. Full list:",
    "No-community-input completion should post the final snapshot"
  );
});

test("Tier-list fast mode sends final output directly to the channel", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: true },
    autoAdvanceSeconds: 0,
  };
  const command = new TierListCommand() as any;
  command.loadDossiers = async () =>
    buildAllSeasonTierDossiers(fixture()).slice(0, 2);
  let snapshots = 0;
  command.postTierListImageSnapshot = async () => {
    snapshots += 1;
  };
  command.tierJudge = judgeForPayload();
  command.tierJudge.reviewFinalTier = async (payload: any) => ({
    source: "ollama",
    revisions: payload.players.map((player: any) => ({
      playerId: player.playerId,
      tier: player.tier,
      position: player.position,
      reasoning: player.reasoning,
      confidence: player.confidence,
    })),
  });
  let edits = 0;
  const channelPayloads: any[] = [];

  try {
    await command.start({
      options: {
        getInteger: () => null,
        getBoolean: (name: string) => name === "fast_mode",
      },
      deferReply: async () => {},
      editReply: async () => {
        edits += 1;
      },
      channel: {
        isTextBased: () => true,
        send: async (payload: any) => {
          channelPayloads.push(payload);
          return { id: `channel-${channelPayloads.length}` };
        },
      },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(snapshots === 1, "Final snapshot should still be posted");
  assert(
    edits === 1,
    "Fast mode should only edit the initial processing reply"
  );
  const verdictPayloads = channelPayloads.filter((payload) =>
    payload.embeds?.[0]?.toJSON().title.startsWith("🤖 AI Verdict: ")
  );
  assert(
    verdictPayloads.length === 2,
    "Fast mode should post one verdict message per processed player"
  );
  assert(
    verdictPayloads.every((payload) =>
      payload.embeds?.[0]?.toJSON().description.startsWith("> ")
    ),
    "Fast mode verdict messages should include the judge reasoning"
  );
  assert(
    verdictPayloads.every(
      (payload) => !hasComponent(payload, "tierlist:placement-next")
    ),
    "Fast mode verdict messages should not include placement controls"
  );
  assert(
    channelPayloads.some((payload) =>
      payload.embeds?.[0]?.toJSON().title.includes("Fast Mode Complete")
    ),
    "Fast mode completion should be sent directly to the channel"
  );
});

test("Tier-list pause button cancels auto-advance", async () => {
  const command = new TierListCommand() as any;
  const state = command.manager.start(buildAllSeasonTierDossiers(fixture()));
  command.manager.setAutoAdvanceTimer(setTimeout(() => {}, 10000));

  await command.handleButtonPress({
    customId: "tierlist:placement-pause",
    guild: {},
    member: { roles: { cache: { has: () => true } } },
    channel: { isTextBased: () => false },
    reply: async () => {},
  } as any);

  assert(state.paused, "Pause should mark the event paused");
  assert(!state.autoAdvanceTimer, "Pause should clear the timer");
});

test("Tier-list auto-advance places the next player after delay", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: false },
    autoAdvanceSeconds: 1,
  };
  const command = new TierListCommand() as any;
  command.manager.start(buildAllSeasonTierDossiers(fixture()).slice(0, 2));
  command.tierJudge = judgeForPayload();

  try {
    await withImmediateTimers(async () => {
      await command.next({
        options: { getInteger: () => 1 },
        deferReply: async () => {},
        editReply: async () => {},
        followUp: async () => {},
        channel: { isTextBased: () => false },
      });
      await waitForTick();
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    command.manager.getState().placementCount === 2,
    "Auto-advance should place the next queued player"
  );
});

test("Tier-list rerate votes dedupe and reach threshold once", async () => {
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 1);
  const state = command.manager.start(dossiers);
  command.manager.commitPlacement({
    playerId: dossiers[0].playerId,
    displayName: dossiers[0].displayName,
    tier: "B",
    position: "mid",
    reasoning: "test",
    confidence: "medium",
    score: dossiers[0].score,
  });

  for (const userId of ["u1", "u1", "u2", "u3"]) {
    await command.handleButtonPress({
      customId: "tierlist:placement-rerate",
      guild: {},
      user: { id: userId, bot: false },
      showModal: async () => {},
      reply: async () => {},
    } as any);
  }

  assert(
    state.activePlacementReview?.voters.length === 3,
    "Duplicate rerate voters should count once"
  );
  assert(
    state.activePlacementReview?.thresholdReached,
    "Third unique vote should reach the rerate threshold"
  );
});

test("Tier-list no-community-input mode rejects stale rerate buttons", async () => {
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 1);
  command.manager.start(dossiers, { noCommunityInput: true });
  command.manager.commitPlacement({
    playerId: dossiers[0].playerId,
    displayName: dossiers[0].displayName,
    tier: "B",
    position: "mid",
    reasoning: "test",
    confidence: "medium",
    score: dossiers[0].score,
  });
  let reply = "";

  await command.handleButtonPress({
    customId: "tierlist:placement-rerate",
    guild: {},
    user: { id: "u1", bot: false },
    showModal: async () => {
      throw new Error("Stale rerate button should not open a modal");
    },
    reply: async (payload: any) => {
      reply = payload.content;
    },
  } as any);

  assert(
    reply.includes("not available"),
    "Stale rerate buttons should explain that rerates are unavailable"
  );
});

test("Tier-list rerate modal justifications are passed into the AI prompt", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = { image: { enabled: false } };
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 1);
  command.manager.start(dossiers);
  command.manager.commitPlacement({
    playerId: dossiers[0].playerId,
    displayName: dossiers[0].displayName,
    tier: "B",
    position: "mid",
    reasoning: "test",
    confidence: "medium",
    score: dossiers[0].score,
  });
  command.manager.recordRerateVote("u1", false, 3);
  command.manager.recordRerateVote("u2", false, 3);
  command.manager.recordRerateVote("u3", false, 3);
  let payload: any;
  command.tierJudge = {
    judge: async (input: any) => {
      payload = input;
      return {
        source: "ollama",
        placement: {
          tier: "B",
          position: "mid",
          reasoning: "Still comparable after review.",
          confidence: "medium",
        },
      };
    },
  };

  try {
    await command.handleModalSubmit({
      customId: "tierlist:rerate-modal:test",
      fields: {
        getTextInputValue: () =>
          "They carry late fights more often than the original summary suggests.",
      },
      reply: async () => {},
      channel: { isTextBased: () => false },
    } as any);
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    payload.communityNotes.summary.includes("late fights"),
    "Accepted rerate justifications should be included as subjective context"
  );
});

test("Tier-list successful rerate updates existing placement", async () => {
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 1);
  const state = command.manager.start(dossiers);
  command.manager.commitPlacement({
    playerId: dossiers[0].playerId,
    displayName: dossiers[0].displayName,
    tier: "B",
    position: "mid",
    reasoning: "test",
    confidence: "medium",
    score: dossiers[0].score,
  });
  command.manager.recordRerateVote("u1", false, 1);
  command.tierJudge = {
    judge: async () => ({
      source: "ollama",
      placement: {
        tier: "A",
        position: "low",
        reasoning: "Review found stronger comparable value.",
        confidence: "medium",
      },
    }),
  };

  await command.handleModalSubmit({
    customId: "tierlist:rerate-modal:test",
    fields: { getTextInputValue: () => "Stronger value against placed peers." },
    reply: async () => {},
    channel: { isTextBased: () => false },
  } as any);

  assert(state.placed.B.length === 0, "Rerate should remove old placement");
  assert(
    state.placed.A.length === 1,
    "Rerate should add the updated placement"
  );
});

test("Tier-list rerate threshold resumes with the next queued player", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = {
    enabledCommunityQuestions: false,
    image: { enabled: false },
    autoAdvanceSeconds: 1,
  };
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 2);
  const state = command.manager.start(dossiers);
  command.manager.commitPlacement({
    playerId: dossiers[0].playerId,
    displayName: dossiers[0].displayName,
    tier: "B",
    position: "mid",
    reasoning: "test",
    confidence: "medium",
    score: dossiers[0].score,
  });
  command.manager.recordRerateVote("u1", false, 1);
  command.tierJudge = judgeForPayload();

  try {
    await withImmediateTimers(async () => {
      await command.handleModalSubmit({
        customId: "tierlist:rerate-modal:test",
        fields: {
          getTextInputValue: () => "Recheck this before moving on.",
        },
        reply: async () => {},
        followUp: async () => ({}),
        channel: { isTextBased: () => false },
      } as any);
      await waitForTick();
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(
    state.unplacedPlayerIds.length === 0,
    "Rerate completion should continue to the next queued player"
  );
  assert(
    state.placementHistory
      .map((placement: TierPlacement) => placement.playerId)
      .join(",") === `${dossiers[0].playerId},${dossiers[1].playerId}`,
    "Rerate completion should not move the next queued player to the bottom"
  );
});

test("Tier-list failed rerate leaves placement unchanged", async () => {
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 1);
  const state = command.manager.start(dossiers);
  command.manager.commitPlacement({
    playerId: dossiers[0].playerId,
    displayName: dossiers[0].displayName,
    tier: "B",
    position: "mid",
    reasoning: "test",
    confidence: "medium",
    score: dossiers[0].score,
  });
  command.manager.recordRerateVote("u1", false, 1);
  command.tierJudge = {
    judge: async () => ({ source: "fallback", reason: "offline" }),
  };

  await command.handleModalSubmit({
    customId: "tierlist:rerate-modal:test",
    fields: { getTextInputValue: () => "Please review their team impact." },
    reply: async () => {},
    channel: { isTextBased: () => false },
  } as any);

  assert(
    state.placed.B.length === 1,
    "Failed rerate should keep old placement"
  );
  assert(
    state.placed.A.length === 0,
    "Failed rerate should not add a duplicate"
  );
});

test("Tier-list rereview updates existing placement without duplication", async () => {
  const config = ConfigManager.getConfig();
  const originalTierList = config.tierList;
  config.tierList = { image: { enabled: false } };
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 1);
  const state = command.manager.start(dossiers);
  command.manager.commitPlacement({
    playerId: dossiers[0].playerId,
    displayName: dossiers[0].displayName,
    tier: "B",
    position: "mid",
    reasoning: "test",
    confidence: "medium",
    score: dossiers[0].score,
  });
  command.tierJudge = {
    judge: async () => ({
      source: "ollama",
      placement: {
        tier: "A",
        position: "low",
        reasoning: "Re-review found stronger peer value.",
        confidence: "high",
      },
    }),
  };
  let posts = 0;
  command.postTierListImageSnapshot = async () => {
    posts += 1;
  };
  const payloads: any[] = [];

  try {
    await command.rereview({
      options: {
        getString: (name: string) =>
          name === "player" ? dossiers[0].displayName : "late fight impact",
      },
      deferReply: async () => {},
      editReply: async (payload: any) => {
        payloads.push(payload);
      },
      followUp: async (payload: any) => {
        payloads.push(payload);
      },
      channel: { isTextBased: () => false },
    });
  } finally {
    config.tierList = originalTierList;
  }

  assert(state.placed.B.length === 0, "Rereview should remove old placement");
  assert(state.placed.A.length === 1, "Rereview should add updated placement");
  assert(
    state.placementHistory.length === 1,
    "Rereview should not add duplicate history entries"
  );
  assert(posts === 1, "Rereview should post a fresh image snapshot");
  assert(
    payloads[0].embeds[0].toJSON().title.startsWith("🤖 Re-reviewing "),
    "Rereview should start with a processing embed"
  );
  assert(
    payloads[1].embeds[0].toJSON().title.startsWith("🤖 AI Verdict: "),
    "Rereview should finish with a verdict embed"
  );
});

test("Tier-list rereview no-change and failure keep placement", async () => {
  const command = new TierListCommand() as any;
  const dossiers = buildAllSeasonTierDossiers(fixture()).slice(0, 1);
  const state = command.manager.start(dossiers);
  const original = {
    playerId: dossiers[0].playerId,
    displayName: dossiers[0].displayName,
    tier: "B" as const,
    position: "mid" as const,
    reasoning: "test",
    confidence: "medium" as const,
    score: dossiers[0].score,
  };
  command.manager.commitPlacement(original);

  command.tierJudge = {
    judge: async () => ({
      source: "ollama",
      placement: {
        tier: "B",
        position: "mid",
        reasoning: "test",
        confidence: "medium",
      },
    }),
  };
  let result = await command.reviewPlacedPlayer(dossiers[0], original);
  assert(!result.changed, "Identical rereview should report no change");
  assert(
    state.placed.B.length === 1 && state.placed.A.length === 0,
    "No-change rereview should keep the placement"
  );

  command.tierJudge = {
    judge: async () => ({ source: "fallback", reason: "offline" }),
  };
  result = await command.reviewPlacedPlayer(dossiers[0], original);
  assert(!result.changed, "Failed rereview should report no change");
  assert(
    state.placed.B.length === 1 && state.placed.A.length === 0,
    "Failed rereview should keep the placement"
  );
});

test("Tier-list rereview rejects unknown or unplaced players", async () => {
  const command = new TierListCommand() as any;
  command.manager.start(buildAllSeasonTierDossiers(fixture()).slice(0, 1));
  let reply: any;

  await command.rereview({
    options: {
      getString: (name: string) =>
        name === "player" ? "missing-player" : null,
    },
    reply: async (payload: any) => {
      reply = payload;
    },
  });

  assert(
    reply.content.includes("not currently placed"),
    "Rereview should reject players who are not placed"
  );
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

function monthsBefore(date: Date, months: number) {
  const copy = new Date(date);
  copy.setMonth(copy.getMonth() - months);
  return copy;
}

function startInteraction(
  limit: number | null,
  playedRecentlyMonths: number | null,
  fastMode = false,
  noCommunityInput = false
) {
  return {
    options: {
      getInteger: (name: string) =>
        name === "limit"
          ? limit
          : name === "played_recently"
            ? playedRecentlyMonths
            : null,
      getBoolean: (name: string) =>
        name === "fast_mode"
          ? fastMode
          : name === "no_community_input"
            ? noCommunityInput
            : null,
    },
    deferReply: async () => {},
    editReply: async () => {},
  };
}

function hasComponent(payload: any, customId: string) {
  const components = payload.components ?? [];
  return components.some((row: any) =>
    (row.components ?? row.data?.components ?? []).some(
      (component: any) =>
        component.data?.custom_id === customId ||
        component.customId === customId
    )
  );
}

async function withMockedRandom<T>(
  values: number[],
  callback: () => Promise<T>
) {
  const originalRandom = Math.random;
  let index = 0;
  Math.random = () => values[index++] ?? values.at(-1) ?? 0;
  try {
    return await callback();
  } finally {
    Math.random = originalRandom;
  }
}

function placement(
  playerId: string,
  displayName: string,
  tier: "S" | "A" | "B" | "C" | "D" | "E",
  score: number,
  confidence: "medium"
): TierPlacement {
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

function lowSampleDossier(playerId: string): PlayerTierDossier {
  return {
    playerId,
    displayName: playerId,
    gamesPlayed: 1,
    seasonsPlayed: 1,
    lastPlayedAt: new Date(),
    provisional: true,
    limitedSample: true,
    statisticalBand: "C",
    score: 48,
    objectiveSummary: `${playerId}: 1 all-season game, 1-0 record.`,
    notableStrengths: ["Tiny sample had a positive result."],
    riskNotes: ["Very low sample; treat as provisional regardless of record."],
    confidenceNotes: ["Provisional: fewer than three all-season games."],
    stats: {
      wins: 1,
      losses: 0,
      winRate: 1,
      adjustedWinScore: 0.6,
      mvpCount: 0,
      mvpEligibleGames: 0,
      mvpRate: 0,
      smoothedMvpRate: 0.1,
      captainEligibleGames: 1,
      captainRate: 1,
      captainGames: 1,
      captainWins: 1,
      captainWinRate: 1,
      smoothedCaptainWinRate: 0.55,
      underdogWins: 1,
      draftGames: 1,
      averageDraftSlotPercentile: 0.5,
      draftValue: 0.5,
      peakElo: 1200,
      finalEloAverage: 1200,
      averageElo: 1200,
      averageSeasonEloPercentile: 0.9,
      maps: {},
      modifiers: {},
      gameTypes: {},
      doubleEloGames: 0,
    },
  };
}

function anchorDossier(
  playerId: string,
  gamesPlayed: number,
  score: number
): PlayerTierDossier {
  const losses = Math.max(0, gamesPlayed - Math.round(gamesPlayed * 0.6));
  const wins = gamesPlayed - losses;
  return {
    playerId,
    displayName: playerId,
    gamesPlayed,
    seasonsPlayed: 3,
    lastPlayedAt: new Date(),
    provisional: false,
    limitedSample: false,
    statisticalBand: "C",
    score,
    objectiveSummary: `${playerId}: established all-season sample.`,
    notableStrengths: ["Established statistical profile."],
    riskNotes: ["Synthetic fixture only."],
    confidenceNotes: ["Significant sample."],
    stats: {
      wins,
      losses,
      winRate: wins / Math.max(1, gamesPlayed),
      adjustedWinScore: 0.5 + score / 200,
      mvpCount: Math.round(gamesPlayed / 5),
      mvpEligibleGames: gamesPlayed - Math.floor(gamesPlayed / 3),
      mvpRate: 0.2,
      smoothedMvpRate: 0.18,
      captainEligibleGames: gamesPlayed - Math.round(gamesPlayed / 5),
      captainRate:
        Math.floor(gamesPlayed / 3) /
        Math.max(1, gamesPlayed - Math.round(gamesPlayed / 5)),
      captainGames: Math.floor(gamesPlayed / 3),
      captainWins: Math.floor(gamesPlayed / 5),
      captainWinRate: 0.5,
      smoothedCaptainWinRate: 0.5,
      underdogWins: 2,
      draftGames: gamesPlayed,
      averageDraftSlotPercentile: 0.5,
      draftValue: 0.5,
      peakElo: 1000 + score,
      finalEloAverage: 1000 + score,
      averageElo: 1000 + score,
      averageSeasonEloPercentile: score / 100,
      maps: {},
      modifiers: {},
      gameTypes: {},
      doubleEloGames: 0,
    },
  };
}

function syntheticDossierDrafts(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const score = count - index;
    return {
      playerId: `synthetic-${index}`,
      displayName: `Synthetic${index}`,
      gamesPlayed: 10,
      seasonsPlayed: 2,
      lastPlayedAt: new Date(),
      provisional: false,
      limitedSample: false,
      score,
      objectiveSummary: `Synthetic${index}: representative fixture player.`,
      notableStrengths: ["Useful all-round statistical profile."],
      riskNotes: ["Synthetic fixture only."],
      confidenceNotes: ["Synthetic confidence."],
      stats: {
        wins: 5,
        losses: 5,
        winRate: 0.5,
        adjustedWinScore: 0.5,
        mvpCount: 0,
        mvpEligibleGames: 10,
        mvpRate: 0,
        smoothedMvpRate: 0,
        captainEligibleGames: 10,
        captainRate: 0,
        captainGames: 0,
        captainWins: 0,
        captainWinRate: null,
        smoothedCaptainWinRate: null,
        underdogWins: 0,
        draftGames: 0,
        averageDraftSlotPercentile: null,
        draftValue: 0,
        peakElo: 1000 + score,
        finalEloAverage: 1000 + score,
        averageElo: 1000 + score,
        averageSeasonEloPercentile: score / Math.max(1, count),
        maps: {},
        modifiers: {},
        gameTypes: {},
        doubleEloGames: 0,
      },
    };
  });
}

function tierCounts(dossiers: PlayerTierDossier[]) {
  return dossiers.reduce(
    (counts, dossier) => {
      counts[dossier.statisticalBand] += 1;
      return counts;
    },
    { S: 0, A: 0, B: 0, C: 0, D: 0, E: 0 }
  );
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

function waitForTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
