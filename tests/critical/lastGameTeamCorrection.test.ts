import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { Prisma, Team } from "@prisma/client";
import {
  applyTeamCorrection,
  commitTeamCorrection,
  loadTeamCorrection,
} from "../../src/database/LastGameTeamCorrection";
import { GameInstance } from "../../src/database/GameInstance";
import { Elo } from "../../src/logic/Elo";
import { ConfigManager } from "../../src/ConfigManager";
import { parseTeamCorrectionArgs } from "../../src/util/TeamCorrectionArgs";

function fixture() {
  const season = { id: "season", number: 1, isActive: true };
  const parts = ["Alice", "Bob", "Cara", "Dan"].map((name, index) => ({
    id: `part-${index}`,
    playerId: name,
    gameId: "last",
    seasonId: season.id,
    ignUsed: name,
    team: index < 2 ? Team.RED : Team.BLUE,
    mvp: index < 2,
    captain: index === 0,
    votedForAMVP: index === 1,
    draftSlotPlacement: index,
    player: { id: name, latestIGN: name, discordSnowflake: `${100 + index}` },
  }));
  const game = {
    id: "last",
    seasonId: season.id,
    finished: true,
    cleanupState: "COMPLETE",
    startTime: new Date("2026-11-01T11:00:00Z"),
    endTime: new Date("2026-11-01T12:00:00Z"),
    winner: Team.RED,
    doubleElo: true,
    eloRated: true,
    persistenceFingerprint: "original-receipt",
    settings: { map: "DUELSTAL" },
    redTeamPlan: { raw: "unchanged" },
    blueTeamPlan: { raw: "unchanged too" },
    participantsIGNs: parts.map((p) => p.ignUsed),
    gameParticipations: parts,
    eloHistories: parts.map((p) => ({
      id: `elo-${p.id}`,
      playerId: p.playerId,
      seasonId: season.id,
      gameId: "last",
      elo: 999,
      createdAt: new Date("2026-11-01T12:01:00Z"),
    })),
  };
  const stats = parts.map((p) => ({
    id: `stats-${p.id}`,
    playerId: p.playerId,
    seasonId: season.id,
    elo: 999,
    wins: p.team === Team.RED ? 1 : 0,
    losses: p.team === Team.RED ? 0 : 1,
    winStreak: p.team === Team.RED ? 1 : 0,
    loseStreak: p.team === Team.RED ? 0 : 1,
    biggestWinStreak: p.team === Team.RED ? 1 : 0,
    biggestLosingStreak: p.team === Team.RED ? 0 : 1,
  }));
  const prior: any[] = [];
  const histories: any[] = [];
  const writes: Array<{ model: string; args: any }> = [];
  const tx = {
    season: { findFirst: async () => season, count: async () => 1 },
    game: {
      findFirst: async () => game,
      count: async () => 1,
      update: async (args: any) => {
        writes.push({ model: "game", args });
      },
    },
    gameParticipation: {
      findMany: async () => prior,
      update: async (args: any) => {
        writes.push({ model: "part", args });
      },
      delete: async (args: any) => {
        writes.push({ model: "part-delete", args });
      },
    },
    eloHistory: {
      findMany: async () => histories,
      update: async (args: any) => {
        writes.push({ model: "history", args });
      },
      delete: async (args: any) => {
        writes.push({ model: "history-delete", args });
      },
    },
    playerStats: {
      findMany: async () => stats,
      updateMany: async (args: any) => {
        writes.push({ model: "stats", args });
        return { count: 1 };
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, game, season, stats, prior, histories, writes };
}

// Seed authoritative older records and materialize the existing (uncorrected) stats.
function addPriorResult(
  f: ReturnType<typeof fixture>,
  playerId: string,
  id: string,
  endTime: Date,
  elo: number | null,
  team: Team = Team.RED,
  winner: Team = Team.RED
) {
  const game = {
    id,
    seasonId: "season",
    finished: true,
    eloRated: elo !== null,
    winner,
    endTime,
  };
  f.prior.push({ playerId, gameId: id, seasonId: "season", team, game });
  if (elo !== null)
    f.histories.push({ playerId, gameId: id, seasonId: "season", elo, game });
}

function syncCurrentStats(f: ReturnType<typeof fixture>) {
  for (const stats of f.stats) {
    const part = f.game.gameParticipations.find(
      (p) => p.playerId === stats.playerId
    )!;
    const prior = f.prior
      .filter((p) => p.playerId === stats.playerId)
      .sort((a, b) => a.game.endTime.getTime() - b.game.endTime.getTime());
    let wins = 0,
      losses = 0,
      winStreak = 0,
      loseStreak = 0,
      bestWin = 0,
      bestLoss = 0;
    for (const result of [...prior, { team: part.team, game: f.game }]) {
      if (result.team === result.game.winner) {
        wins++;
        winStreak++;
        loseStreak = 0;
      } else {
        losses++;
        loseStreak++;
        winStreak = 0;
      }
      bestWin = Math.max(bestWin, winStreak);
      bestLoss = Math.max(bestLoss, loseStreak);
    }
    const histories = f.histories
      .filter((h) => h.playerId === stats.playerId)
      .sort((a, b) => b.game.endTime.getTime() - a.game.endTime.getTime());
    Object.assign(stats, {
      elo:
        f.game.eloHistories.find((h) => h.playerId === stats.playerId)?.elo ??
        histories[0]?.elo ??
        1000,
      wins,
      losses,
      winStreak,
      loseStreak,
      biggestWinStreak: bestWin,
      biggestLosingStreak: bestLoss,
    });
  }
}

async function rejects(work: () => Promise<unknown>, message: string) {
  let rejected = false;
  try {
    await work();
  } catch (error) {
    rejected = String(error).includes(message);
  }
  assert(rejected, `Expected rejection containing '${message}'`);
}

test("last-game team correction uses current Elo and preserves MVPs, votes and game metadata", async () => {
  const f = fixture();
  const source = JSON.stringify(f.game);
  // Unequal pre-game Elo exercises blended expectation and favoured-loss penalty.
  f.game.gameParticipations.forEach((p, index) => {
    for (let n = 0; n < 3; n++) {
      addPriorResult(
        f,
        p.playerId,
        `prior-${index}-${n}`,
        new Date(1000 + n),
        1000 + index * 200
      );
    }
  });
  syncCurrentStats(f);
  const moves = [{ identifier: "bob", team: Team.BLUE }];
  const plan = await loadTeamCorrection(f.tx, moves, {});
  assertEqual(f.writes.length, 0, "Preview must be read-only");
  const game = GameInstance.getInstance();
  game.reset();
  try {
    const players = plan.updates.map(
      (u, index) =>
        ({
          playerId: u.playerId,
          discordSnowflake: `${100 + index}`,
          ignUsed: u.ign,
          elo: 1000 + index * 200,
          winStreak: 3,
          captain: u.captain,
        }) as any
    );
    game.teams.RED = players.filter(
      (_, index) => plan.updates[index].to === Team.RED
    );
    game.teams.BLUE = players.filter(
      (_, index) => plan.updates[index].to === Team.BLUE
    );
    game.gameWinner = Team.RED;
    game.isDoubleElo = true;
    // Multiple preserved MVP awards may now be on one team: bonuses stay with players.
    game.MVPPlayerRed = "Alice";
    game.MVPPlayerBlue = "Bob";
    (game as any).mvpVoters.add("101");
    game.calculateMeanEloAndExpectedScore();
    const elo = new Elo();
    plan.updates.forEach((u, index) => {
      assertEqual(
        u.next.elo,
        Math.round(
          elo.calculateNewElo(players[index], u.to === Team.RED ? 4 : 0)
        ),
        "Corrected Elo must match current production formula including bonuses"
      );
      assertEqual(u.next.wins, u.to === Team.RED ? 4 : 3, "Wins reconstructed");
      assertEqual(
        u.next.losses,
        u.to === Team.RED ? 0 : 1,
        "Losses reconstructed"
      );
      assertEqual(
        u.next.biggestWinStreak,
        u.to === Team.RED ? 4 : 3,
        "Best streak reconstructed"
      );
    });
    await applyTeamCorrection(f.tx, plan, moves, {});
    assertEqual(
      JSON.stringify(f.game),
      source,
      "Source game and flags must be untouched"
    );
    assertEqual(
      f.writes.filter((w) => w.model === "part").length,
      1,
      "Only moved participation changes"
    );
    const partWrite = f.writes.find((w) => w.model === "part")!;
    assertEqual(
      JSON.stringify(partWrite.args.data),
      JSON.stringify({ team: Team.BLUE }),
      "Only team field changes"
    );
    assertEqual(
      f.writes.filter((w) => w.model === "stats").length,
      4,
      "All participants recalculated"
    );
    assertEqual(
      f.writes.filter((w) => w.model === "history").length,
      4,
      "All Elo histories updated in place"
    );
    assert(
      f.writes
        .filter((w) => w.model === "history")
        .every((w) => Object.keys(w.args.data).join() === "elo"),
      "History IDs/timestamps preserved"
    );
  } finally {
    game.reset();
  }
});

test("unrated last-game correction updates results without awarding Elo or bonuses", async () => {
  const f = fixture();
  f.game.eloRated = false;
  f.game.eloHistories = [];
  syncCurrentStats(f);
  const moves = [{ identifier: "Alice", team: Team.BLUE }];
  const plan = await loadTeamCorrection(f.tx, moves, {});
  assert(
    plan.updates.every((u) => u.next.elo === 1000),
    "Unrated Elo remains pre-game Elo"
  );
  await applyTeamCorrection(f.tx, plan, moves, {});
  assertEqual(
    f.writes.filter((w) => w.model === "history").length,
    0,
    "No history invented for unrated game"
  );
});

test("last-game correction rejects stale previews before any writes", async () => {
  const f = fixture();
  const moves = [{ identifier: "Alice", team: Team.BLUE }];
  const plan = await loadTeamCorrection(f.tx, moves, {});
  f.stats[0].elo += 1;
  await rejects(
    () => applyTeamCorrection(f.tx, plan, moves, {}),
    "changed since preview"
  );
  assertEqual(f.writes.length, 0, "Stale confirmation writes nothing");
});

test("last-game correction refuses unsafe or invalid roster requests", async () => {
  for (const scenario of [
    "unknown",
    "duplicate",
    "empty team",
    "history",
    "later game",
    "cleanup",
    "double Elo",
  ]) {
    const f = fixture();
    let moves = [{ identifier: "Alice", team: Team.BLUE }];
    let expected = "";
    if (scenario === "unknown") {
      moves[0].identifier = "Missing";
      expected = "missing or ambiguous";
    }
    if (scenario === "duplicate") {
      moves.push(moves[0]);
      expected = "more than once";
    }
    if (scenario === "empty team") {
      moves.push({ identifier: "Bob", team: Team.BLUE });
      expected = "Both corrected teams";
    }
    if (scenario === "history") {
      f.game.eloHistories.pop();
      expected = "incomplete/inconsistent";
    }
    if (scenario === "later game") {
      f.prior.push({
        playerId: "Alice",
        game: { finished: true, endTime: f.game.endTime },
      });
      expected = "Last-game correction is unsafe";
    }
    if (scenario === "cleanup") {
      f.game.cleanupState = "PENDING";
      expected = "cleanup is pending";
    }
    if (scenario === "double Elo") {
      (f.game as any).doubleElo = null;
      expected = "--double-elo";
    }
    await rejects(() => loadTeamCorrection(f.tx, moves, {}), expected);
    assertEqual(f.writes.length, 0, "Invalid request writes nothing");
  }
});

test("legacy last-game correction requires explicit double Elo and preserves stored overrides", async () => {
  const f = fixture();
  (f.game as any).doubleElo = null;
  const moves = [{ identifier: "Alice", team: Team.BLUE }];
  const plan = await loadTeamCorrection(f.tx, moves, { legacyDoubleElo: true });
  assertEqual(plan.doubleElo, true, "Explicit legacy value accepted");
  f.game.doubleElo = false;
  const stored = await loadTeamCorrection(f.tx, moves, {
    legacyDoubleElo: true,
  });
  assertEqual(
    stored.doubleElo,
    false,
    "Stored double Elo flag takes precedence"
  );
});

test("removing a saved participant restores prior stats and recalculates only the remaining roster", async () => {
  const f = fixture();
  // Move and remove in one request; Dan's high Elo must be excluded from BLUE's mean.
  const moves = [{ identifier: "Alice", team: Team.BLUE }];
  const options = { removePlayers: ["103"] };
  addPriorResult(
    f,
    "Dan",
    "prior-dan",
    new Date(1000),
    1800,
    Team.BLUE,
    Team.RED
  );
  syncCurrentStats(f);
  const source = JSON.stringify(f.game);
  const plan = await loadTeamCorrection(f.tx, moves, options);
  assertEqual(f.writes.length, 0, "Removal preview writes nothing");
  const removed = plan.updates.find((u) => u.playerId === "Dan")!;
  assertEqual(removed.to, null, "Preview marks player as removed");
  assertEqual(removed.next.elo, 1800, "Removed player's previous Elo restored");
  assertEqual(removed.next.wins, 0, "No win from removed game");
  assertEqual(removed.next.losses, 1, "Only prior loss retained");
  assertEqual(removed.next.loseStreak, 1, "Prior losing streak restored");
  assertEqual(
    removed.next.biggestLosingStreak,
    1,
    "Prior best losing streak restored"
  );
  const comparison = fixture();
  const equalPlan = await loadTeamCorrection(comparison.tx, moves, options);
  for (const update of plan.updates.filter((u) => u.to !== null)) {
    assertEqual(
      update.next.elo,
      equalPlan.updates.find((u) => u.playerId === update.playerId)!.next.elo,
      "Removed player's Elo must not affect team expectations"
    );
  }
  await applyTeamCorrection(f.tx, plan, moves, options);
  assertEqual(
    JSON.stringify(f.game),
    source,
    "Plan does not mutate source records"
  );
  assertEqual(
    f.writes.filter((w) => w.model === "part-delete").length,
    1,
    "Only requested participation deleted"
  );
  assertEqual(
    f.writes.find((w) => w.model === "part-delete")!.args.where.id,
    "part-3",
    "Correct participant removed"
  );
  assertEqual(
    f.writes.find((w) => w.model === "history-delete")!.args.where.id,
    "elo-part-3",
    "Only removed player's game history deleted"
  );
  assertEqual(
    f.writes.filter((w) => w.model === "history").length,
    3,
    "Remaining histories updated"
  );
  assertEqual(
    f.writes.filter((w) => w.model === "stats").length,
    4,
    "Removed and retained stats updated"
  );
  const gameWrite = f.writes.find((w) => w.model === "game")!;
  assertEqual(
    JSON.stringify(gameWrite.args.data),
    JSON.stringify({ participantsIGNs: ["Alice", "Bob", "Cara"] }),
    "Only participant display list is changed on Game; winner/plans/metadata preserved"
  );
});

test("removal from an unrated first game restores defaults without deleting the player's account", async () => {
  const f = fixture();
  f.game.eloRated = false;
  f.game.eloHistories = [];
  syncCurrentStats(f);
  const options = { removePlayers: ["Dan"] };
  const plan = await loadTeamCorrection(f.tx, [], options);
  const removed = plan.updates.find((u) => u.playerId === "Dan")!;
  assertEqual(
    JSON.stringify(removed.next),
    JSON.stringify({
      elo: 1000,
      wins: 0,
      losses: 0,
      winStreak: 0,
      loseStreak: 0,
      biggestWinStreak: 0,
      biggestLosingStreak: 0,
    }),
    "First-game removal restores all default stats"
  );
  await applyTeamCorrection(f.tx, plan, [], options);
  assertEqual(
    f.writes.filter((w) => w.model === "history-delete").length,
    0,
    "No unrated history to delete"
  );
  assertEqual(
    f.writes.filter((w) => w.model === "part-delete").length,
    1,
    "Participation is removed"
  );
  // Fake exposes no player delete delegate: removal cannot delete the account.
});

test("removals reject unknown, ambiguous, conflicting, duplicate or MVP players and empty teams", async () => {
  for (const scenario of [
    "unknown",
    "ambiguous",
    "duplicate",
    "conflict",
    "mvp",
    "empty",
    "blank",
    "display list",
  ]) {
    const f = fixture();
    const moves: Array<{ identifier: string; team: Team }> = [];
    const options = { removePlayers: ["Dan"] };
    let expected = "";
    if (scenario === "unknown") {
      options.removePlayers = ["TypoName"];
      expected = "missing or ambiguous";
    }
    if (scenario === "ambiguous") {
      f.game.gameParticipations[2].player.latestIGN = "Dan";
      expected = "missing or ambiguous";
    }
    if (scenario === "duplicate") {
      options.removePlayers = ["Dan", "103"];
      expected = "more than once";
    }
    if (scenario === "conflict") {
      moves.push({ identifier: "103", team: Team.RED });
      expected = "move/remove conflicts";
    }
    if (scenario === "mvp") {
      options.removePlayers = ["Alice"];
      expected = "Cannot remove MVP";
    }
    if (scenario === "empty") {
      options.removePlayers = ["Cara", "Dan"];
      expected = "Both corrected teams";
    }
    if (scenario === "blank") {
      options.removePlayers = ["  "];
      expected = "identifier cannot be empty";
    }
    if (scenario === "display list") {
      f.game.participantsIGNs.pop();
      expected = "participantsIGNs";
    }
    await rejects(() => loadTeamCorrection(f.tx, moves, options), expected);
    assertEqual(f.writes.length, 0, "Invalid removals write nothing");
  }
});

test("roster correction detects inconsistent saved identities, stats and history", async () => {
  for (const scenario of ["identity", "stats", "history"]) {
    const f = fixture();
    let expected = "";
    if (scenario === "identity") {
      f.game.gameParticipations[3].player.id = "wrong";
      expected = "inconsistent player identities";
    }
    if (scenario === "stats") {
      f.stats[3].playerId = "Alice";
      expected = "seasonal stats";
    }
    if (scenario === "history") {
      f.game.eloHistories[3].playerId = "Alice";
      expected = "incomplete/inconsistent";
    }
    await rejects(
      () => loadTeamCorrection(f.tx, [], { removePlayers: ["Dan"] }),
      expected
    );
    assertEqual(f.writes.length, 0, "Corrupt source data writes nothing");
  }
});

test("removal preview is invalidated when source roster, MVP flags, or latest game changes", async () => {
  for (const scenario of ["roster", "mvp", "latest"]) {
    const f = fixture();
    const options = { removePlayers: ["Dan"] };
    const preview = await loadTeamCorrection(f.tx, [], options);
    if (scenario === "roster") f.game.gameParticipations[1].team = Team.BLUE;
    if (scenario === "mvp") f.game.gameParticipations[2].mvp = true;
    if (scenario === "latest")
      f.game.endTime = new Date("2026-11-02T12:00:00Z");
    await rejects(
      () => applyTeamCorrection(f.tx, preview, [], options),
      "changed since preview"
    );
    assertEqual(f.writes.length, 0, "Changed preview must not delete anything");
  }
});

test("team correction CLI validates removal and move options before database access", async () => {
  const parsed = parseTeamCorrectionArgs([
    "--remove",
    " Dan ",
    "--remove",
    "103",
    "--move",
    "Alice=blue",
    "--season",
    "3",
    "--apply",
  ]);
  assertEqual(
    parsed.options.removePlayers!.join(","),
    "Dan,103",
    "Repeatable removals parsed and trimmed"
  );
  assertEqual(
    parsed.moves[0].team,
    Team.BLUE,
    "Team parsed case insensitively"
  );
  assertEqual(parsed.options.seasonNumber, 3, "Explicit season parsed");
  assert(parsed.apply, "Apply remains opt-in");
  assert(
    !parseTeamCorrectionArgs(["--remove", "Dan"]).apply,
    "Default is preview only"
  );
  for (const args of [
    [],
    ["--remove"],
    ["--remove", "  "],
    ["--remove", "--apply"],
    ["--move", "Alice=GREEN"],
    ["--move", " =RED"],
    ["--unknown", "x"],
    ["--remove", "Dan", "--season", "0"],
    ["--remove", "Dan", "--season", "9007199254740992"],
    ["--remove", "Dan", "--double-elo", "maybe"],
    ["--remove", "Dan", "--apply", "--apply"],
  ]) {
    let rejected = false;
    try {
      parseTeamCorrectionArgs(args);
    } catch {
      rejected = true;
    }
    assert(rejected, `Invalid arguments rejected: ${args.join(" ")}`);
  }
});

test("correction refuses incomplete, ambiguous, inconsistent and unordered prior history", async () => {
  for (const scenario of [
    "missing rated",
    "legacy unknown",
    "orphan",
    "duplicate history",
    "duplicate participation",
    "wrong season",
    "wrong game",
    "unrated history",
    "tied dates",
    "pending cleanup",
    "invalid date",
  ]) {
    const f = fixture();
    addPriorResult(f, "Dan", "prior-dan", new Date(1000), 1200);
    syncCurrentStats(f);
    let expected = "";
    if (scenario === "missing rated") {
      f.histories.length = 0;
      expected = "Missing prior rated history";
    }
    if (scenario === "legacy unknown") {
      f.histories.length = 0;
      f.prior[0].game.eloRated = null;
      expected = "ambiguous legacy rating";
    }
    if (scenario === "orphan") {
      f.prior.length = 0;
      expected = "orphaned or inconsistent";
    }
    if (scenario === "duplicate history") {
      f.histories.push(f.histories[0]);
      expected = "orphaned or inconsistent";
    }
    if (scenario === "duplicate participation") {
      f.prior.push(f.prior[0]);
      expected = "participation history is inconsistent";
    }
    if (scenario === "wrong season") {
      f.prior[0].seasonId = "different";
      expected = "participation history is inconsistent";
    }
    if (scenario === "wrong game") {
      f.histories[0].gameId = "different";
      expected = "orphaned or inconsistent";
    }
    if (scenario === "unrated history") {
      f.prior[0].game.eloRated = false;
      expected = "unrated game has Elo history";
    }
    if (scenario === "tied dates") {
      addPriorResult(f, "Dan", "tied", new Date(1000), 1201);
      expected = "tied timestamps";
    }
    if (scenario === "pending cleanup") {
      f.prior[0].game.cleanupState = "PENDING";
      expected = "participation history is inconsistent";
    }
    if (scenario === "invalid date") {
      f.prior[0].game.endTime = new Date(NaN);
      expected = "participation history is inconsistent";
    }
    await rejects(
      () => loadTeamCorrection(f.tx, [], { removePlayers: ["Dan"] }),
      expected
    );
    assertEqual(
      f.writes.length,
      0,
      `Unsafe history writes nothing: ${scenario}`
    );
  }
});

test("correction preserves the last rated Elo across subsequent unrated games", async () => {
  const f = fixture();
  addPriorResult(f, "Dan", "rated", new Date(1000), 1432, Team.BLUE, Team.RED);
  addPriorResult(
    f,
    "Dan",
    "unrated",
    new Date(2000),
    null,
    Team.BLUE,
    Team.BLUE
  );
  syncCurrentStats(f);
  const plan = await loadTeamCorrection(f.tx, [], { removePlayers: ["Dan"] });
  const dan = plan.updates.find((u) => u.playerId === "Dan")!;
  assertEqual(
    dan.next.elo,
    1432,
    "Unrated game must not reset Elo to defaults"
  );
  assertEqual(dan.next.wins, 1, "Unrated win remains counted");
  assertEqual(dan.next.losses, 1, "Rated loss remains counted");
  assertEqual(dan.next.winStreak, 1, "Restored streak includes unrated win");
});

test("correction refuses unrelated current-stat changes instead of silently overwriting them", async () => {
  for (const key of [
    "elo",
    "wins",
    "losses",
    "winStreak",
    "loseStreak",
    "biggestWinStreak",
    "biggestLosingStreak",
  ] as const) {
    const f = fixture();
    f.stats[3][key]++;
    await rejects(
      () => loadTeamCorrection(f.tx, [], { removePlayers: ["Dan"] }),
      "Current stats do not match saved results"
    );
    assertEqual(f.writes.length, 0, "Unrelated drift writes nothing");
  }
});

test("correction validates saved dates, rating ambiguity, seasons and integer bounds", async () => {
  for (const scenario of [
    "start date",
    "end date",
    "reversed dates",
    "season",
    "closed",
    "closing",
    "unknown rating",
    "history overflow",
    "stats overflow",
    "negative counter",
    "display mismatch on move",
  ]) {
    const f = fixture();
    let expected = "";
    if (scenario === "start date") {
      f.game.startTime = new Date(NaN);
      expected = "inconsistent season, dates, or winner";
    }
    if (scenario === "end date") {
      f.game.endTime = new Date(NaN);
      expected = "inconsistent season, dates, or winner";
    }
    if (scenario === "reversed dates") {
      f.game.endTime = new Date(1000);
      expected = "inconsistent season, dates, or winner";
    }
    if (scenario === "season") {
      f.game.seasonId = "other";
      expected = "inconsistent season, dates, or winner";
    }
    if (scenario === "closed" || scenario === "closing") {
      (f.season as any).lifecycleState = scenario.toUpperCase();
      expected = "closing/closed";
    }
    if (scenario === "unknown rating") {
      (f.game as any).eloRated = null;
      f.game.eloHistories = [];
      expected = "cannot safely infer";
    }
    if (scenario === "history overflow") {
      f.game.eloHistories[3].elo = 2147483648;
      expected = "incomplete/inconsistent";
    }
    if (scenario === "stats overflow") {
      f.stats[3].elo = 2147483648;
      expected = "out-of-range stats";
    }
    if (scenario === "negative counter") {
      f.stats[3].wins = -1;
      expected = "out-of-range stats";
    }
    if (scenario === "display mismatch on move") {
      f.game.participantsIGNs.pop();
      expected = "participantsIGNs";
    }
    await rejects(
      () =>
        loadTeamCorrection(f.tx, [{ identifier: "Dan", team: Team.RED }], {}),
      expected
    );
    assertEqual(
      f.writes.length,
      0,
      `Invalid source writes nothing: ${scenario}`
    );
  }
});

test("same-team moves and repeated removals never apply twice", async () => {
  const f = fixture();
  await rejects(
    () =>
      loadTeamCorrection(f.tx, [{ identifier: "Dan", team: Team.BLUE }], {}),
    "already match"
  );
  // Model an already committed removal with remaining stats/history intact.
  f.game.gameParticipations.pop();
  f.game.eloHistories.pop();
  f.game.participantsIGNs.pop();
  f.stats.pop();
  await rejects(
    () => loadTeamCorrection(f.tx, [], { removePlayers: ["Dan"] }),
    "missing or ambiguous"
  );
  assertEqual(f.writes.length, 0, "Repeated operation writes nothing");
});

test("database failure and concurrent stats changes abort the single transaction without retry", async () => {
  for (const scenario of [
    "write failure",
    "concurrent stats",
    "lost acknowledgement",
  ]) {
    const f = fixture();
    const options = { removePlayers: ["Dan"] };
    const preview = await loadTeamCorrection(f.tx, [], options);
    let attempts = 0;
    let committed: typeof f.writes = [];
    if (scenario === "write failure") {
      (f.tx.eloHistory as any).update = async () => {
        throw new Error("injected write failure");
      };
    }
    if (scenario === "concurrent stats")
      (f.tx.playerStats as any).updateMany = async () => ({ count: 0 });
    // Offline transaction stand-in: publish pending writes only after successful work.
    const transaction = async <T>(
      work: (tx: Prisma.TransactionClient) => Promise<T>
    ): Promise<T> => {
      attempts++;
      const result = await work(f.tx);
      committed = [...f.writes];
      if (scenario === "lost acknowledgement")
        throw new Error("connection lost after commit");
      return result;
    };
    await rejects(
      () => commitTeamCorrection(transaction, preview, [], options),
      "Correction was not confirmed"
    );
    assertEqual(attempts, 1, "No nontransactional fallback or blind retry");
    if (scenario === "lost acknowledgement")
      assert(committed.length > 0, "Lost acknowledgement can hide commit");
    else
      assertEqual(
        committed.length,
        0,
        "Failed transaction does not publish staged writes"
      );
  }
});

test("invalid configuration and Elo overflow stop before any writes", async () => {
  const config = ConfigManager.getConfig();
  const oldBonus = config.mvpBonus;
  try {
    for (const value of [NaN, Infinity, -1, 2147483648]) {
      config.mvpBonus = value;
      const f = fixture();
      await rejects(
        () =>
          loadTeamCorrection(f.tx, [{ identifier: "Dan", team: Team.RED }], {}),
        value === 2147483648 ? "out-of-range stats" : "finite, nonnegative"
      );
      assertEqual(f.writes.length, 0, "Bad configuration must not write");
    }
  } finally {
    config.mvpBonus = oldBonus;
  }
});

test("moving an awarded MVP preserves their award even when both MVPs end on one team", async () => {
  const f = fixture();
  f.game.gameParticipations[1].mvp = false;
  f.game.gameParticipations[2].mvp = true;
  const moves = [{ identifier: "Alice", team: Team.BLUE }];
  const plan = await loadTeamCorrection(f.tx, moves, {});
  assertEqual(
    plan.updates.filter((u) => u.mvp && u.to === Team.BLUE).length,
    2,
    "Awards stay on their players"
  );
  await applyTeamCorrection(f.tx, plan, moves, {});
  assert(
    f.writes
      .filter((w) => w.model === "part")
      .every((w) => Object.keys(w.args.data).join() === "team"),
    "Moving an MVP must not recount votes or rewrite awards"
  );
});

test("automatic selection refuses ambiguous seasons and equally dated latest games", async () => {
  const f = fixture();
  (f.tx.season as any).count = async () => 2;
  await rejects(
    () => loadTeamCorrection(f.tx, [], { removePlayers: ["Dan"] }),
    "Multiple active seasons"
  );
  await loadTeamCorrection(f.tx, [], {
    seasonNumber: 1,
    removePlayers: ["Dan"],
  });
  (f.tx.season as any).count = async () => 1;
  (f.tx.game as any).count = async () => 2;
  await rejects(
    () => loadTeamCorrection(f.tx, [], { removePlayers: ["Dan"] }),
    "identical timestamps"
  );
  assertEqual(f.writes.length, 0, "Ambiguous selection never writes");
});
