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
    "$transaction",
  ];
  const originals = keys.map((key) => [key, client[key]]);
  const fixture: any = {
    games: [],
    participations: [],
    stats: [],
    seasons: [{ id: "S6", type: "RANKED" }],
    players: [],
    profiles: new Map<string, string[]>(),
    writes: 0,
  };
  TitleStore.setOverride(
    [
      "COMMODORE",
      "OVERSEER",
      "UNYIELDING",
      "PARAGON",
      "CHAMPION",
      "ACE",
      "ELITE",
    ].map((id) => ({ id, label: id }))
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
      findUnique: async () => ({
        id: "S6",
        type: "RANKED",
        titlesProcessedAt: fixture.checkpoint,
      }),
      findMany: async () => fixture.seasons,
    };
    client.profile = {
      findUnique: async ({ where }: any) =>
        fixture.profiles.has(where.playerId)
          ? { unlockedTitles: [...fixture.profiles.get(where.playerId)] }
          : null,
      upsert: async ({ where, update }: any) => {
        fixture.writes++;
        if (fixture.failPlayer === where.playerId)
          throw new Error("profile failure");
        fixture.profiles.set(where.playerId, update.unlockedTitles);
      },
    };
    client.$transaction = async (work: any) => {
      const snapshot = new Map(fixture.profiles);
      const writes = fixture.writes;
      const checkpoint = fixture.checkpoint;
      const queued = fixture.queued;
      try {
        const result = await work(client);
        if (fixture.conflictOnce) {
          fixture.conflictOnce = false;
          throw Object.assign(new Error("write conflict"), { code: "P2034" });
        }
        return result;
      } catch (error) {
        fixture.profiles = snapshot;
        fixture.writes = writes;
        fixture.checkpoint = checkpoint;
        fixture.queued = queued;
        if ((error as { code?: string }).code === "P2034") {
          fixture.profiles.set("A", [
            ...(fixture.profiles.get("A") ?? []),
            "CONCURRENT",
            "UNYIELDING",
          ]);
        }
        throw error;
      }
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
      const writes = f.writes;
      const second = await TitleService.reconcile(closingSeasonId);
      assert(f.writes === writes, "Unchanged awards do not rewrite profiles");
      assert(
        second.newlyUnlocked.length === 0 && second.blocks.length === 0,
        "Repeating reconciliation produces no duplicate unlocks or announcements"
      );
    });
  }
});

test("title placement preserves competition ties and relaxed exclusions", async () => {
  await withHistory(async (f) => {
    f.seasons = [
      { id: "S6", type: "RANKED" },
      { id: "S7", type: "RELAXED" },
      { id: "S8", type: null },
    ];
    f.stats = [
      { playerId: "A", seasonId: "S6", elo: 1300, wins: 1, losses: 0 },
      { playerId: "B", seasonId: "S6", elo: 1300, wins: 1, losses: 0 },
      { playerId: "C", seasonId: "S6", elo: 1200, wins: 1, losses: 0 },
      { playerId: "D", seasonId: "S7", elo: 1500, wins: 1, losses: 0 },
      { playerId: "E", seasonId: "S8", elo: 1200, wins: 1, losses: 0 },
    ];
    f.profiles.set("A", ["EXISTING", "EXISTING"]);
    const first = await TitleService.reconcile();
    assert(
      f.profiles.get("A").join() === "EXISTING,CHAMPION,ACE,ELITE",
      "Old titles survive and duplicates are removed"
    );
    assert(
      f.profiles.get("B").join() === "CHAMPION,ACE,ELITE",
      "Tied first place awards match"
    );
    assert(
      f.profiles.get("C").join() === "ELITE",
      "Next player is third, not second"
    );
    assert(!f.profiles.has("D"), "Relaxed seasons grant no placement titles");
    assert(
      f.profiles.get("E").includes("CHAMPION"),
      "Legacy season type remains ranked"
    );
    assert(
      first.newlyUnlocked.length === 4,
      "Only actual new awards are announced"
    );
    const writes = f.writes;
    await TitleService.reconcile();
    assert(f.writes === writes, "Repeat reconciliation performs no writes");
  });
});

test("closure title writes and announcements roll back and retry together", async () => {
  await withHistory(async (f) => {
    f.stats = [
      { playerId: "A", seasonId: "S6", elo: 1400, wins: 25, losses: 0 },
      { playerId: "B", seasonId: "S6", elo: 1300, wins: 25, losses: 0 },
    ];
    f.profiles.set("A", ["LEGACY"]);
    const persist = async (_tx: any, result: any) => {
      f.queued = result.blocks;
      f.checkpoint = new Date();
      if (f.failQueue) throw new Error("outbox failure");
    };
    f.failPlayer = "B";
    let rejected = false;
    try {
      await TitleService.reconcile("S6", persist);
    } catch {
      rejected = true;
    }
    assert(
      rejected &&
        f.profiles.get("A").join() === "LEGACY" &&
        !f.profiles.has("B"),
      "Partial profile writes roll back"
    );
    f.failPlayer = undefined;
    f.failQueue = true;
    rejected = false;
    try {
      await TitleService.reconcile("S6", persist);
    } catch {
      rejected = true;
    }
    assert(
      rejected && !f.checkpoint && !f.queued && !f.profiles.has("B"),
      "Outbox and profile writes roll back together"
    );
    f.failQueue = false;
    const result = await TitleService.reconcile("S6", persist);
    assert(
      result.newlyUnlocked.length === 2 && f.checkpoint && f.queued.length,
      "Retry announces all newly persisted awards"
    );
    assert(f.profiles.get("A").includes("LEGACY"), "Existing titles retained");
    const repeat = await TitleService.reconcile("S6", persist);
    assert(
      !repeat.newlyUnlocked.length && !repeat.blocks.length,
      "Committed closure is not repeated"
    );
  });
});

test("title transaction retry preserves concurrent awards and reports only committed unlocks", async () => {
  await withHistory(async (f) => {
    f.stats = [
      { playerId: "A", seasonId: "S6", elo: 1400, wins: 25, losses: 0 },
    ];
    f.profiles.set("A", ["LEGACY"]);
    f.conflictOnce = true;
    const result = await TitleService.reconcile("S6");
    assert(
      f.profiles.get("A").join() ===
        "LEGACY,CONCURRENT,UNYIELDING,CHAMPION,ACE,ELITE",
      "Concurrent writes survive retry"
    );
    assert(
      result.newlyUnlocked[0].titleIds.join() === "CHAMPION,ACE,ELITE",
      "Already granted titles are not announced twice"
    );
  });
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
