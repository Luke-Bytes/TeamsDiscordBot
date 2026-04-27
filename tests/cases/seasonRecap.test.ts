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
        draftSlotPlacement: pos + 1,
        votedForAMVP: id === "steady" || id === "buddy",
        player: player(id, id),
      })),
      ...blueIds.map((id, pos) => ({
        playerId: id,
        ignUsed: id,
        team: Team.BLUE,
        mvp: id === "onegame",
        captain: pos === 0,
        draftSlotPlacement: redIds.length + pos + 1,
        votedForAMVP: id === "steady",
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

function richGame(
  idx: number,
  redIds: string[],
  blueIds: string[],
  winner: Team
): SeasonRecapGame {
  const start = new Date(base.getTime() + idx * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 40 * 60 * 1000);
  return {
    id: `rich-${idx}`,
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
      organiserBannedClasses: [],
      sharedCaptainBannedClasses: [],
      nonSharedCaptainBannedClasses: { RED: [], BLUE: [] },
      modifiers: [],
    },
    gameParticipations: [
      ...redIds.map((id, pos) => ({
        playerId: id,
        ignUsed: id,
        team: Team.RED,
        mvp: id === "anchor" && idx === 2,
        captain: pos === 0,
        draftSlotPlacement: pos + 1,
        votedForAMVP: pos !== 2,
        player: player(id, id),
      })),
      ...blueIds.map((id, pos) => ({
        playerId: id,
        ignUsed: id,
        team: Team.BLUE,
        mvp: id === "late1" && idx === 0,
        captain: pos === 0,
        draftSlotPlacement: redIds.length + pos + 1,
        votedForAMVP: pos !== 2,
        player: player(id, id),
      })),
    ],
  };
}

function richFixture(): SeasonRecapData {
  const games = [
    richGame(0, ["early1", "early2", "anchor"], ["late1", "late2", "late3"], Team.BLUE),
    richGame(1, ["early1", "early2", "anchor"], ["late1", "late2", "late3"], Team.BLUE),
    richGame(2, ["early1", "early2", "anchor"], ["late1", "late2", "late3"], Team.RED),
    richGame(3, ["early1", "early2", "anchor"], ["late1", "late2", "late3"], Team.BLUE),
  ];

  return {
    seasonNumber: 10,
    games,
    playerStats: [
      {
        playerId: "early1",
        elo: 1060,
        wins: 1,
        losses: 3,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 1,
        biggestLosingStreak: 3,
        player: player("early1", "early1"),
      },
      {
        playerId: "early2",
        elo: 1040,
        wins: 1,
        losses: 3,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 1,
        biggestLosingStreak: 3,
        player: player("early2", "early2"),
      },
      {
        playerId: "anchor",
        elo: 1010,
        wins: 1,
        losses: 3,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 1,
        biggestLosingStreak: 3,
        player: player("anchor", "anchor"),
      },
      {
        playerId: "late1",
        elo: 1090,
        wins: 3,
        losses: 1,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 3,
        biggestLosingStreak: 1,
        player: player("late1", "late1"),
      },
      {
        playerId: "late2",
        elo: 1110,
        wins: 3,
        losses: 1,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 3,
        biggestLosingStreak: 1,
        player: player("late2", "late2"),
      },
      {
        playerId: "late3",
        elo: 1130,
        wins: 3,
        losses: 1,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 3,
        biggestLosingStreak: 1,
        player: player("late3", "late3"),
      },
    ],
    histories: games.flatMap((g, gameIdx) =>
      g.gameParticipations.map((gp) => ({
        playerId: gp.playerId,
        gameId: g.id,
        elo:
          gp.playerId.startsWith("late")
            ? 1000 + gameIdx * 25 + 30
            : gp.playerId.startsWith("early")
              ? 1000 - gameIdx * 20
              : 1000 + (gameIdx % 2 === 0 ? 10 : -10),
        createdAt: new Date(g.endTime.getTime() + 1000),
      }))
    ),
  };
}

function turnaroundFixture(): SeasonRecapData {
  const games = [
    richGame(0, ["turn", "steady", "helper"], ["opp1", "opp2", "opp3"], Team.BLUE),
    richGame(1, ["turn", "steady", "helper"], ["opp1", "opp2", "opp3"], Team.BLUE),
    richGame(2, ["opp1", "opp2", "opp3"], ["turn", "steady", "helper"], Team.BLUE),
    richGame(3, ["opp1", "opp2", "opp3"], ["turn", "steady", "helper"], Team.BLUE),
  ];

  return {
    seasonNumber: 11,
    games,
    playerStats: [
      {
        playerId: "turn",
        elo: 1005,
        wins: 2,
        losses: 2,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 2,
        biggestLosingStreak: 2,
        player: player("turn", "turn"),
      },
      {
        playerId: "steady",
        elo: 1080,
        wins: 3,
        losses: 1,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 3,
        biggestLosingStreak: 1,
        player: player("steady", "steady"),
      },
      {
        playerId: "helper",
        elo: 1020,
        wins: 2,
        losses: 2,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 2,
        biggestLosingStreak: 2,
        player: player("helper", "helper"),
      },
      {
        playerId: "opp1",
        elo: 990,
        wins: 1,
        losses: 3,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 1,
        biggestLosingStreak: 3,
        player: player("opp1", "opp1"),
      },
      {
        playerId: "opp2",
        elo: 980,
        wins: 1,
        losses: 3,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 1,
        biggestLosingStreak: 3,
        player: player("opp2", "opp2"),
      },
      {
        playerId: "opp3",
        elo: 970,
        wins: 1,
        losses: 3,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 1,
        biggestLosingStreak: 3,
        player: player("opp3", "opp3"),
      },
    ],
    histories: games.flatMap((g, gameIdx) =>
      g.gameParticipations.map((gp) => ({
        playerId: gp.playerId,
        gameId: g.id,
        elo: gp.playerId === "turn" ? 1000 + gameIdx * 20 : 1000,
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

test("season recap includes draft order insights", () => {
  const result = generateSeasonRecapFromData(fixture(), {
    thresholds: { minPlayerSeasonShare: 0 },
  });
  const output = result.blocks.join("\n");

  assert(output.includes("📋 Draft Board"), "draft section should appear");
  assert(
    output.includes("First off the board"),
    "first pick counts should appear"
  );
  assert(output.includes("Last but not least"), "last pick counts should appear");
});

test("season recap uses clear stat labels", () => {
  const result = generateSeasonRecapFromData(fixture(), {
    thresholds: { minPlayerSeasonShare: 0 },
  });
  const output = result.blocks.join("\n");

  assert(
    output.includes("Biggest Win Streaks"),
    "win streak label should be explicit"
  );
  assert(
    output.includes("Most Likely To Win Together"),
    "duo win label should be explicit"
  );
  assert(
    output.includes("Most Likely To Lose Together"),
    "duo loss label should be explicit"
  );
  assert(
    !output.includes("Close-game MVP"),
    "ambiguous close-game MVP stat should not appear"
  );
});

test("season recap includes MVP voting participation", () => {
  const result = generateSeasonRecapFromData(fixture(), {
    thresholds: { minPlayerSeasonShare: 0 },
  });
  const output = result.blocks.join("\n");

  assert(output.includes("🗳️ MVP Voting"), "MVP voting section should appear");
  assert(
    output.includes("Most MVP Votes Cast"),
    "top MVP voters should appear"
  );
  assert(
    output.includes("Average MVP Ballot Turnout"),
    "average MVP voting turnout should appear"
  );
});

test("season recap only counts Elo recovery after dropping below threshold", () => {
  const result = generateSeasonRecapFromData(fixture(), {
    thresholds: { minPlayerGames: 3, minPlayerSeasonShare: 0 },
  });
  const output = result.blocks.join("\n");

  assert(
    output.includes("Biggest Elo Recoveries After Dropping Below 950"),
    "recovery label should show the threshold"
  );
  assert(
    !output.includes("steady: +120 from season low (1000"),
    "normal climb from starting Elo should not count as recovery"
  );
});

test("season recap includes the most average player section", () => {
  const result = generateSeasonRecapFromData(fixture(), {
    thresholds: { minPlayerSeasonShare: 0 },
  });
  const output = result.blocks.join("\n");

  assert(
    output.includes("🎯 Most Average Player"),
    "most average player section should appear"
  );
  assert(
    output.includes("Closest to Median Elo"),
    "closest to median label should appear"
  );
});

test("season recap explains close-game and underdog stats", () => {
  const result = generateSeasonRecapFromData(fixture(), {
    thresholds: { minPlayerSeasonShare: 0, underdogEloGap: 999 },
  });
  const output = result.blocks.join("\n");

  assert(output.includes("Biggest Upset"), "biggest upset should appear");
  assert(
    output.includes("Most Underdog Wins"),
    "underdog player stat should appear"
  );
  assert(
    output.includes("Upset captains"),
    "upset captain stat should use the same underdog definition"
  );
  assert(
    output.includes("Clutch closers are players with the most wins"),
    "clutch closers should be explained"
  );
});

test("season recap includes draft value, trio, and turnaround insights", () => {
  const result = generateSeasonRecapFromData(richFixture(), {
    thresholds: { minPlayerSeasonShare: 0 },
  });
  const output = result.blocks.join("\n");

  assert(output.includes("💎 Draft Value"), "draft value section should appear");
  assert(
    output.includes("Best Sleeper Draft Picks"),
    "late draft picks should appear"
  );
  assert(
    output.includes("First Pick Pressure"),
    "early draft performance should appear"
  );
  assert(
    output.includes("🧩 Three-Player Cores"),
    "three-player cores section should appear"
  );
  assert(
    output.includes("Worst Three-Player Cores"),
    "worst three-player cores should appear"
  );
  assert(output.includes("🔀 Pair Paths"), "pair paths section should appear");
  assert(
    output.includes("Never Teamed Together"),
    "pairs that never teamed should appear"
  );
  assert(
    output.includes("Never Played Against Each Other"),
    "pairs that never played against each other should appear"
  );
  assert(
    output.includes("Biggest Turnarounds"),
    "turnaround section should appear"
  );
});

test("season recap includes most-voted games and MVP turnout", () => {
  const result = generateSeasonRecapFromData(richFixture(), {
    thresholds: { minPlayerSeasonShare: 0 },
  });
  const output = result.blocks.join("\n");

  assert(output.includes("🗳️ MVP Voting"), "MVP voting section should appear");
  assert(output.includes("Most Voted Games"), "most-voted games should appear");
  assert(
    output.includes("Average MVP Ballot Turnout"),
    "average ballot turnout should appear"
  );
});

test("season recap turnaround only appears with enough half-season games", () => {
  const result = generateSeasonRecapFromData(turnaroundFixture(), {
    thresholds: { minPlayerSeasonShare: 0 },
  });
  const output = result.blocks.join("\n");

  assert(
    output.includes("Biggest Turnarounds"),
    "turnarounds section should appear"
  );
  assert(
    output.includes("turn: 0.0% -> 100.0%"),
    "turnaround should compare first and second halves"
  );
});
