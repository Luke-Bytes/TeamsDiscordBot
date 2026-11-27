import { Team } from "@prisma/client";
import { buildSeasonRecapModel } from "../../src/logic/seasonRecap/model";
import { DEFAULT_SEASON_RECAP_THRESHOLDS } from "../../src/logic/seasonRecap/types";
import { assert, assertEqual } from "../framework/assert";
import { test } from "../framework/test";
import {
  generatePersonalSeasonWrappedFromData,
  PersonalSeasonWrappedResult,
} from "../../src/logic/seasonRecap/PersonalSeasonWrapped";
import {
  SeasonRecapData,
  SeasonRecapGame,
} from "../../src/logic/seasonRecap/SeasonRecap";

const base = new Date("2026-02-01T19:00:00.000Z");

function player(id: string, latestIGN: string) {
  return { id, latestIGN, discordSnowflake: `20000000000000000${id.length}` };
}

function game(
  idx: number,
  redIds: string[],
  blueIds: string[],
  winner: Team
): SeasonRecapGame {
  const start = new Date(base.getTime() + idx * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 45 * 60 * 1000);
  return {
    id: `wrapped-game-${idx}`,
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
        mvp: id === "hero" && idx < 3,
        captain: id === "hero" && idx === 0,
        draftSlotPlacement: pos + 1,
        votedForAMVP: true,
        player: player(id, id),
      })),
      ...blueIds.map((id, pos) => ({
        playerId: id,
        ignUsed: id,
        team: Team.BLUE,
        mvp: id === "hero" && idx < 3,
        captain: false,
        draftSlotPlacement: redIds.length + pos + 1,
        votedForAMVP: pos !== 1,
        player: player(id, id),
      })),
    ],
  };
}

function fixture(): SeasonRecapData {
  const games = [
    game(0, ["hero", "buddy"], ["rival", "foil"], Team.RED),
    game(1, ["hero", "buddy"], ["rival", "foil"], Team.RED),
    game(2, ["rival", "foil"], ["hero", "buddy"], Team.BLUE),
    game(3, ["hero", "foil"], ["rival", "buddy"], Team.BLUE),
    game(4, ["hero", "buddy"], ["rival", "foil"], Team.RED),
  ];

  return {
    seasonNumber: 12,
    games,
    playerStats: [
      {
        playerId: "hero",
        elo: 1130,
        wins: 4,
        losses: 1,
        winStreak: 1,
        loseStreak: 0,
        biggestWinStreak: 3,
        biggestLosingStreak: 1,
        player: player("hero", "hero"),
      },
      {
        playerId: "buddy",
        elo: 1090,
        wins: 4,
        losses: 1,
        winStreak: 1,
        loseStreak: 0,
        biggestWinStreak: 3,
        biggestLosingStreak: 1,
        player: player("buddy", "buddy"),
      },
      {
        playerId: "rival",
        elo: 980,
        wins: 1,
        losses: 4,
        winStreak: 0,
        loseStreak: 1,
        biggestWinStreak: 1,
        biggestLosingStreak: 3,
        player: player("rival", "rival"),
      },
      {
        playerId: "foil",
        elo: 990,
        wins: 1,
        losses: 4,
        winStreak: 0,
        loseStreak: 1,
        biggestWinStreak: 1,
        biggestLosingStreak: 3,
        player: player("foil", "foil"),
      },
    ],
    histories: games.flatMap((g, gameIdx) =>
      g.gameParticipations.map((gp) => ({
        playerId: gp.playerId,
        gameId: g.id,
        elo:
          gp.playerId === "hero"
            ? 1000 + (gameIdx + 1) * 26
            : gp.playerId === "buddy"
              ? 1000 + (gameIdx + 1) * 18
              : 1000 - (gameIdx + 1) * 4,
        createdAt: new Date(g.endTime.getTime() + 1000),
      }))
    ),
  };
}

function output(result: PersonalSeasonWrappedResult) {
  return [
    result.title,
    result.description,
    ...result.fields.flatMap((field) => [field.name, field.value]),
    result.footer,
  ].join("\n");
}

test("personal season wrapped generates a compact player recap", () => {
  const result = generatePersonalSeasonWrappedFromData(fixture(), "hero");
  if (!result) throw new Error("Expected wrapped result");
  assertEqual(result.summary.games, 5, "Uses player game count");
  assert(result.summary.seasonType.length > 0, "Uses a season headline");

  const text = output(result);
  assert(text.includes("Season 12 Wrapped"), "Includes title");
  assert(text.includes("Season Vibe"), "Includes aesthetic vibe field");
  assert(text.includes("People Lore"), "Includes relationship section");
  assert(
    text.includes("Special Mentions"),
    "Includes special mentions section"
  );
  assert(
    /\*\*[^\n]+\*\*/.test(text),
    "Boldens wrapped card titles consistently"
  );
  if (text.includes("Best Duo") && text.includes("Cursed Duo")) {
    assert(
      text.indexOf("Best Duo") < text.indexOf("Cursed Duo"),
      "People lore should show best duo before cursed duo"
    );
  }
  assert(
    ["🌟", "🤝", "💔", "⚔️", "🐉", "💎", "🗺️", "🔥"].some((emoji) =>
      text.includes(emoji)
    ),
    "Includes aesthetic recap emojis"
  );
  assert(!text.includes("Generated by"), "Footer avoids generated-by copy");
  assert(!text.includes("\nRecord\n"), "Does not duplicate /stats record");
  assert(!text.includes("\nElo\n"), "Does not duplicate /stats Elo");
});

test("personal model retains full Elo context and exact target outcomes after corrections", () => {
  const data = fixture();
  const extra = game(5, ["buddy"], ["rival"], Team.BLUE);
  data.games.push(
    extra,
    game(6, ["hero", "buddy"], ["rival", "foil"], Team.RED)
  );
  data.histories.push({
    playerId: "rival",
    gameId: extra.id,
    elo: 1400,
    createdAt: extra.endTime,
  });
  data.playerStats[1].elo = data.playerStats[0].elo;
  for (const corrected of [false, true]) {
    if (corrected) {
      extra.winner = Team.RED;
      data.histories[data.histories.length - 1].elo = 900;
      data.games[6].winner = Team.BLUE;
    }
    const full = buildSeasonRecapModel(
      data.games,
      data.histories,
      DEFAULT_SEASON_RECAP_THRESHOLDS
    );
    const personal = buildSeasonRecapModel(
      data.games,
      data.histories,
      DEFAULT_SEASON_RECAP_THRESHOLDS,
      "hero"
    );
    assertEqual(
      JSON.stringify([...personal.gameContexts]),
      JSON.stringify([...full.gameContexts]),
      "All team contexts match"
    );
    assertEqual(
      JSON.stringify(personal.outcomesByPlayer.get("hero")),
      JSON.stringify(full.outcomesByPlayer.get("hero")),
      "Target outcomes match the full model"
    );
    assertEqual(
      personal.outcomesByPlayer.size,
      1,
      "No other player outcomes are allocated"
    );
    const wrapped = generatePersonalSeasonWrappedFromData(data, "hero");
    assertEqual(wrapped?.summary.rank, 1, "Tied Elo retains competition rank");
  }
});

test("personal season wrapped returns null for missing or inactive stats", () => {
  const data = fixture();
  assertEqual(
    generatePersonalSeasonWrappedFromData(data, "missing"),
    null,
    "Missing player has no wrapped result"
  );
  data.playerStats.push({
    playerId: "inactive",
    elo: 1000,
    wins: 0,
    losses: 0,
    winStreak: 0,
    loseStreak: 0,
    biggestWinStreak: 0,
    biggestLosingStreak: 0,
    player: player("inactive", "inactive"),
  });
  assertEqual(
    generatePersonalSeasonWrappedFromData(data, "inactive"),
    null,
    "Zero-game player has no wrapped result"
  );
});

test("personal season wrapped output avoids raw ids and Discord mentions", () => {
  const result = generatePersonalSeasonWrappedFromData(fixture(), "hero");
  if (!result) throw new Error("Expected wrapped result");

  const text = output(result);
  assert(!text.includes("<@"), "Should not mention Discord users");
  assert(!text.includes("wrapped-game-"), "Should not expose raw game ids");
});

test("personal season wrapped includes map, draft, and matchup lore", () => {
  const result = generatePersonalSeasonWrappedFromData(fixture(), "hero");
  if (!result) throw new Error("Expected wrapped result");

  const text = output(result);
  assert(
    text.includes("Favourite Matchup") || text.includes("Nemesis"),
    "Head-to-head lore should appear"
  );
  assert(
    text.includes("Map Specialist") || text.includes("Cursed Map"),
    "Map lore should appear"
  );
  assert(
    text.includes("First-Pick Pressure") || text.includes("Draft Steal"),
    "Draft lore should appear"
  );
});
