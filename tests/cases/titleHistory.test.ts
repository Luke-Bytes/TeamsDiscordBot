import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { prismaClient } from "../../src/database/prismaClient";
import { TitleService } from "../../src/logic/TitleService";
import { TitleStore } from "../../src/util/TitleStore";

async function withHistory(run: (fixture: any) => Promise<void>) {
  const client = prismaClient as any;
  const keys = [
    "game",
    "gameParticipation",
    "playerStats",
    "player",
    "season",
    "profile",
  ];
  const originals = keys.map((key) => [key, client[key]]);
  const fixture: any = {
    games: [],
    participations: [],
    stats: [],
    players: [],
    profiles: new Map<string, string[]>(),
    writes: 0,
  };
  TitleStore.setOverride(
    ["COMMODORE", "OVERSEER", "UNYIELDING", "PARAGON", "CHAMPION"].map(
      (id) => ({ id, label: id })
    )
  );
  try {
    client.game = {
      findRaw: async (args: any) => {
        assert(!args.filter?.seasonId, "Lifetime games span all seasons");
        assert(
          !args.options.limit && !args.options.singleBatch,
          "Raw history reads have no single-batch cap"
        );
        if (fixture.gameError) throw fixture.gameError;
        return fixture.games;
      },
      findMany: async () => {
        throw new Error("Strict Game decoding must not read legacy title data");
      },
    };
    client.gameParticipation = {
      findRaw: async ({ filter, options }: any) => {
        if (fixture.participationError) throw fixture.participationError;
        assert(!options.limit, "Captain history is not truncated");
        return fixture.participations.filter((row: any) =>
          filter.captain.$in.includes(row.captain)
        );
      },
      findMany: async ({ where, select }: any) => {
        assert(where.mvp && !select.team, "Only MVP IDs use typed decoding");
        return fixture.participations
          .filter((row: any) => row.mvp === true)
          .map(({ playerId }: any) => ({ playerId }));
      },
    };
    client.playerStats = { findMany: async () => fixture.stats };
    client.player = { findMany: async () => fixture.players };
    client.season = {
      findUnique: async () => ({ id: "S6", type: "RANKED" }),
      findMany: async () => [{ id: "S6", type: "RANKED" }],
    };
    client.profile = {
      findUnique: async ({ where }: any) => ({
        unlockedTitles: fixture.profiles.get(where.playerId) ?? [],
      }),
      upsert: async ({ where, update }: any) => {
        fixture.writes++;
        fixture.profiles.set(where.playerId, update.unlockedTitles);
      },
    };
    await run(fixture);
  } finally {
    for (const [key, value] of originals) client[key] = value;
    TitleStore.clearOverride();
  }
}

test("titles tolerate legacy nulls in season closure and manual reconciliation", async () => {
  for (const closingSeasonId of ["S6", undefined]) {
    await withHistory(async (f) => {
      f.players = ["Host", "Organiser", "Captain", "Lifetime"].map((name) => ({
        id: name,
        latestIGN: name,
        discordSnowflake: name,
      }));
      f.stats = [
        {
          playerId: "Lifetime",
          seasonId: "S6",
          wins: 25,
          losses: 0,
          elo: 1200,
        },
      ];
      f.games = Array.from({ length: 25 }, (_, index) => ({
        _id: `G${index}`,
        organiser: index % 2 ? null : 123,
        host: " hOsT ",
        winner: "RED",
      }));
      f.games.push(
        ...Array.from({ length: 25 }, (_, index) => ({
          _id: `O${index}`,
          organiser: "Organiser",
          // Missing host must not discard organiser credit.
        })),
        { _id: "unknown", winner: null, organiser: null, host: null },
        { _id: "invalid", winner: "GREEN" }
      );
      f.participations = Array.from({ length: 10 }, (_, index) => ({
        playerId: "Captain",
        gameId: `G${index}`,
        captain: [true, "true", 1][index % 3],
        team: " red ",
        mvp: true,
      }));
      for (const [playerId, gameId, team] of [
        ["NullTeam", "unknown", null],
        ["MissingTeam", "unknown", undefined],
        ["InvalidTeam", "invalid", "GREEN"],
        ["MissingGame", "deleted", "RED"],
        ["UnknownWinner", "unknown", "RED"],
        ["LosingCaptain", "G0", "BLUE"],
      ]) {
        f.participations.push(
          ...Array.from({ length: 10 }, () => ({
            playerId,
            gameId,
            team,
            captain: true,
          }))
        );
      }

      const first = await TitleService.reconcile(closingSeasonId);
      assert(f.profiles.get("Host")?.includes("OVERSEER"), "Valid hosts count");
      assert(
        f.profiles.get("Organiser")?.includes("OVERSEER"),
        "Valid organisers count independently"
      );
      assert(
        f.profiles.get("Captain")?.includes("COMMODORE") &&
          f.profiles.get("Captain")?.includes("PARAGON"),
        "Valid captain wins and MVPs still count"
      );
      assert(
        f.profiles.get("Lifetime")?.includes("UNYIELDING") &&
          f.profiles.get("Lifetime")?.includes("CHAMPION"),
        "Lifetime and placement awards still work"
      );
      assert(
        f.profiles.size === 4,
        "Invalid or unknown teams/winners and losing captains earn no title"
      );
      assert(first.blocks.length > 0, "New titles are announced");
      const second = await TitleService.reconcile(closingSeasonId);
      assert(
        second.newlyUnlocked.length === 0 && second.blocks.length === 0,
        "Repeating reconciliation produces no duplicate unlocks or announcements"
      );
    });
  }
});

test("titles include valid history beyond the old 10000-document batch cap", async () => {
  await withHistory(async (f) => {
    f.players = [{ id: "P", latestIGN: "Host" }];
    f.games = Array.from({ length: 10001 }, (_, index) => ({
      _id: `legacy-${index}`,
      organiser: null,
      host: null,
      winner: null,
    }));
    f.participations = Array.from({ length: 10001 }, () => ({
      playerId: "P",
      gameId: "legacy-0",
      team: null,
      captain: true,
    }));
    for (let index = 0; index < 25; index++) {
      f.games.push({ _id: `valid-${index}`, host: "Host", winner: "BLUE" });
      if (index < 10) {
        f.participations.push({
          playerId: "P",
          gameId: `valid-${index}`,
          team: "BLUE",
          captain: true,
        });
      }
    }
    await TitleService.reconcile();
    assert(
      f.profiles.get("P")?.includes("OVERSEER") &&
        f.profiles.get("P")?.includes("COMMODORE"),
      "Awards use games and participations beyond the first batch"
    );
  });
});

test("titles match historical ObjectId game references", async () => {
  await withHistory(async (f) => {
    f.players = [{ id: "P", latestIGN: "Captain" }];
    f.games = [{ _id: { $oid: "0123456789abcdef01234567" }, winner: "BLUE" }];
    f.participations = Array.from({ length: 10 }, () => ({
      playerId: "P",
      gameId: "0123456789abcdef01234567",
      team: "BLUE",
      captain: true,
    }));
    await TitleService.reconcile();
    assert(
      f.profiles.get("P")?.includes("COMMODORE"),
      "ObjectIds join correctly"
    );
  });
});

test("title history read failures stop reconciliation before profile writes", async () => {
  for (const field of ["gameError", "participationError"]) {
    await withHistory(async (f) => {
      f.stats = [
        { playerId: "P", seasonId: "S6", wins: 50, losses: 0, elo: 1500 },
      ];
      f.profiles.set("P", ["EXISTING"]);
      const expected = new Error(`Simulated ${field}`);
      f[field] = expected;
      let failure: unknown;
      try {
        await TitleService.reconcile("S6");
      } catch (error) {
        failure = error;
      }
      assert(failure === expected, "Database failures propagate to the caller");
      assert(f.writes === 0, "No titles are written from incomplete history");
      assert(
        f.profiles.get("P").join() === "EXISTING",
        "Previously unlocked titles are preserved"
      );
    });
  }
});

test("unexpected raw history responses cannot silently become empty history", async () => {
  for (const invalid of [{ cursor: { firstBatch: [] } }, null, [null]]) {
    await withHistory(async (f) => {
      f.games = invalid;
      let failed = false;
      try {
        await TitleService.reconcile();
      } catch {
        failed = true;
      }
      assert(
        failed && f.writes === 0,
        "Malformed query results fail before writes"
      );
    });
  }
});
