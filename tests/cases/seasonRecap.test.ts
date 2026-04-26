import { Team } from "@prisma/client";
import { assert } from "../framework/assert";
import { test } from "../framework/test";
import {
  generateSeasonRecapFromData,
  SeasonRecapData,
  SeasonRecapGame,
} from "../../src/logic/seasonRecap/SeasonRecap";

const base = new Date("2026-01-01T19:00:00.000Z");

function player(id: string, latestIGN: string) {
  return { id, latestIGN, discordSnowflake: `10000000000000000${id.length}` };
}

function game(
  idx: number,
  redIds: string[],
  blueIds: string[],
  winner: Team,
  opts: Partial<SeasonRecapGame> = {}
): SeasonRecapGame {
  const start = new Date(base.getTime() + idx * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + (45 + idx * 5) * 60 * 1000);
  return {
    id: `game-${idx}`,
    finished: true,
    startTime: start,
    endTime: end,
    winner,
    type: "DRAFT",
    doubleElo: false,
    organiser: "Org",
    host: "Host",
    settings: {
      map: idx % 2 === 0 ? "DUELSTAL" : "CANYON1V1",
      organiserBannedClasses: idx > 2 ? ["SCOUT"] : ["SWAPPER"],
      sharedCaptainBannedClasses: [],
      nonSharedCaptainBannedClasses: { RED: [], BLUE: [] },
      modifiers: idx > 3 ? [{ category: "Pace", name: "Fast Iron" }] : [],
    },
    gameParticipations: [
      ...redIds.map((id, pos) => ({
        playerId: id,
        ignUsed: id,
        team: Team.RED,
        mvp: (id === "steady" && idx <= 3) || id === "onegame",
        captain: pos === 0,
        player: player(id, id),
      })),
      ...blueIds.map((id, pos) => ({
        playerId: id,
        ignUsed: id,
        team: Team.BLUE,
        mvp: id === "onegame",
        captain: pos === 0,
        player: player(id, id),
      })),
    ],
    ...opts,
  };
}

function fixture(): SeasonRecapData {
  const games = [
    game(0, ["steady", "buddy"], ["rival", "foil"], Team.RED),
    game(1, ["steady", "buddy"], ["rival", "foil"], Team.RED),
    game(2, ["steady", "buddy"], ["rival", "foil"], Team.RED),
    game(3, ["steady", "buddy"], ["rival", "foil"], Team.BLUE),
    game(4, ["steady", "buddy"], ["rival", "foil"], Team.RED),
    game(5, ["onegame", "foil"], ["steady", "buddy"], Team.RED),
  ];

  return {
    seasonNumber: 9,
    games,
    playerStats: [
      {
        playerId: "steady",
        elo: 1120,
        wins: 5,
        losses: 1,
        winStreak: 1,
        loseStreak: 0,
        biggestWinStreak: 3,
        biggestLosingStreak: 1,
        player: player("steady", "steady"),
      },
      {
        playerId: "buddy",
        elo: 1100,
        wins: 4,
        losses: 2,
        winStreak: 0,
        loseStreak: 1,
        biggestWinStreak: 3,
        biggestLosingStreak: 1,
        player: player("buddy", "buddy"),
      },
      {
        playerId: "rival",
        elo: 930,
        wins: 1,
        losses: 4,
        winStreak: 0,
        loseStreak: 2,
        biggestWinStreak: 1,
        biggestLosingStreak: 3,
        player: player("rival", "rival"),
      },
      {
        playerId: "foil",
        elo: 960,
        wins: 2,
        losses: 4,
        winStreak: 1,
        loseStreak: 0,
        biggestWinStreak: 1,
        biggestLosingStreak: 3,
        player: player("foil", "foil"),
      },
      {
        playerId: "onegame",
        elo: 1030,
        wins: 1,
        losses: 0,
        winStreak: 1,
        loseStreak: 0,
        biggestWinStreak: 1,
        biggestLosingStreak: 0,
        player: player("onegame", "onegame"),
      },
    ],
    histories: games.flatMap((g, gameIdx) =>
      g.gameParticipations.map((gp) => ({
        playerId: gp.playerId,
        gameId: g.id,
        elo:
          gp.playerId === "steady"
            ? 1000 + (gameIdx + 1) * 20
            : gp.playerId === "buddy"
              ? 1000 + (gameIdx + 1) * 15
              : 1000 - (gameIdx + 1) * 10,
        createdAt: new Date(g.endTime.getTime() + 1000),
      }))
    ),
  };
}

test("season recap keeps Discord blocks under the configured limit", () => {
  const result = generateSeasonRecapFromData(fixture(), {
    maxBlockLength: 500,
    thresholds: { minPlayerSeasonShare: 0 },
  });

  assert(result.blocks.length > 1, "small max length should split blocks");
  assert(
    result.blocks.every((block) => block.length <= 500),
    "all blocks should stay under max length"
  );
});

test("season recap excludes one-game wonders from rate insights", () => {
  const result = generateSeasonRecapFromData(fixture(), {
    thresholds: {
      minPlayerGames: 3,
      minPlayerSeasonShare: 0,
      minMvpGames: 3,
    },
  });
  const output = result.blocks.join("\n");

  assert(output.includes("steady: 66.7%"), "qualified MVP rate should appear");
  assert(
    !output.includes("onegame: 100.0%"),
    "single-game MVP rate should not be treated as insight"
  );
});

test("season recap output avoids raw ids and Discord mentions", () => {
  const result = generateSeasonRecapFromData(fixture(), {
    thresholds: { minPlayerSeasonShare: 0 },
  });
  const output = result.blocks.join("\n");

  assert(!output.includes("<@"), "recap should not mention Discord users");
  assert(!output.includes("game-"), "recap should not expose raw game ids");
});
