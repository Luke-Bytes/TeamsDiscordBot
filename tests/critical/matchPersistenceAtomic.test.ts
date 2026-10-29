import { Game, Prisma, Team } from "@prisma/client";
import { GameInstance } from "../../src/database/GameInstance";
import {
  MatchCommitUncertainError,
  MatchStore,
  persistCompletedMatch,
} from "../../src/database/MatchPersistence";
import { PlayerInstance } from "../../src/database/PlayerInstance";
import { test } from "../framework/test";
import { assert } from "../framework/assert";

type Row = {
  id: string;
  playerId: string;
  seasonId: string;
  elo: number;
  wins: number;
  losses: number;
  winStreak: number;
  loseStreak: number;
  biggestWinStreak: number;
  biggestLosingStreak: number;
};
type State = {
  games: Record<string, Game>;
  stats: Record<string, Row>;
  participations: string[];
  histories: string[];
};
const initialStats = (playerId: string): Row => ({
  id: `stats-${playerId}`,
  playerId,
  seasonId: "season-1",
  elo: 1000,
  wins: 2,
  losses: 1,
  winStreak: 2,
  loseStreak: 0,
  biggestWinStreak: 2,
  biggestLosingStreak: 1,
});

function gameFixture() {
  const game = GameInstance.getInstance();
  game.reset();
  game.beginConfirmedAnnouncement();
  game.startTime = new Date("2026-10-29T18:00:00Z");
  game.endTime = new Date("2026-10-29T19:00:00Z");
  game.isFinished = true;
  game.gameWinner = Team.RED;
  game.teamsDecidedBy = "RANDOMISED";
  const red = {
    ...initialStats("red-1"),
    discordSnowflake: "discord-red",
    ignUsed: "Red",
    captain: true,
  } as unknown as PlayerInstance;
  const blue = {
    ...initialStats("blue-1"),
    discordSnowflake: "discord-blue",
    ignUsed: "Blue",
  } as unknown as PlayerInstance;
  game.teams.RED = [red];
  game.teams.BLUE = [blue];
  game.calculateMeanEloAndExpectedScore();
  return { game, red, blue };
}

function fakeStore(missingStatsFor?: string) {
  let state: State = {
    games: {},
    stats: {
      "red-1": initialStats("red-1"),
      "blue-1": initialStats("blue-1"),
    },
    participations: [],
    histories: [],
  };
  if (missingStatsFor) delete state.stats[missingStatsFor];
  let failWrite = 0;
  let writeIndex = 0;
  let failAfterCommit = false;
  let failRead = false;
  let queue = Promise.resolve();
  const tick = () => {
    writeIndex++;
    if (failWrite === writeIndex) throw new Error(`Injected database write failure ${writeIndex}`);
  };
  const store: MatchStore = {
    async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
      // Model a serialized, all-or-nothing transaction, not Mongo failover.
      const previous = queue;
      let release: () => void = () => {};
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      writeIndex = 0;
      const copy: State = structuredClone(state);
      const tx = {
        game: {
          findUnique: async ({ where }: any) => copy.games[where.id] ?? null,
          create: async ({ data }: any) => {
            tick();
            if (copy.games[data.id]) throw new Error("Duplicate game ID");
            const record = { ...data, seasonId: data.season.connect.id } as Game;
            copy.games[data.id] = record;
            return record;
          },
        },
        season: {
          findFirst: async () => ({ id: "season-1", type: "RANKED" }),
        },
        player: {
          findUnique: async ({ where }: any) => {
            if (where.discordSnowflake === "discord-red") return { id: "red-1" };
            if (where.discordSnowflake === "discord-blue") return { id: "blue-1" };
            return null;
          },
        },
        playerStats: {
          findUnique: async ({ where }: any) =>
            copy.stats[where.playerId_seasonId.playerId] ?? null,
          create: async ({ data }: any) => {
            tick();
            if (copy.stats[data.playerId]) throw new Error("Duplicate stats");
            const row = {
              ...initialStats(data.playerId),
              seasonId: data.seasonId,
              elo: data.elo,
              wins: 0,
              losses: 0,
              winStreak: 0,
              loseStreak: 0,
              biggestWinStreak: 0,
              biggestLosingStreak: 0,
            };
            copy.stats[data.playerId] = row;
            return row;
          },
          updateMany: async ({ where, data }: any) => {
            tick();
            const row = Object.values(copy.stats).find((s) => s.id === where.id);
            if (!row || Object.entries(where).some(([key, value]) =>
              key !== "id" && row[key as keyof Row] !== value
            )) return { count: 0 };
            Object.assign(row, data);
            return { count: 1 };
          },
        },
        gameParticipation: {
          create: async ({ data }: any) => {
            tick();
            const key = `${data.gameId}:${data.playerId}`;
            if (copy.participations.includes(key)) throw new Error("Duplicate participation");
            copy.participations.push(key);
            return { id: key };
          },
        },
        eloHistory: {
          create: async ({ data }: any) => {
            tick();
            const key = `${data.gameId}:${data.playerId}`;
            if (copy.histories.includes(key)) throw new Error("Duplicate history");
            copy.histories.push(key);
            return { id: key };
          },
        },
      };
      try {
        const result = await work(tx as unknown as Prisma.TransactionClient);
        state = copy;
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error("Lost acknowledgement after commit");
        }
        return result;
      } finally {
        release();
      }
    },
    async findCommitted(id: string) {
      if (failRead) throw new Error("Read unavailable");
      return state.games[id] ?? null;
    },
  };
  return {
    store,
    state: () => structuredClone(state),
    failAt: (n: number) => { failWrite = n; },
    failAfterCommit: () => { failAfterCommit = true; },
    failConfirmationRead: () => { failRead = true; },
  };
}

test("match persistence rolls back every injected critical write and preserves in-memory stats", async () => {
  for (let failAt = 1; failAt <= 7; failAt++) {
    const { game, red, blue } = gameFixture();
    const fake = fakeStore();
    fake.failAt(failAt);
    let failed = false;
    try {
      await persistCompletedMatch(game, fake.store);
    } catch (error) {
      failed = error instanceof MatchCommitUncertainError;
    }
    assert(failed, `write ${failAt} must fail closed`);
    const after = fake.state();
    assert(Object.keys(after.games).length === 0, "No game may commit partially");
    assert(after.participations.length === 0 && after.histories.length === 0,
      "No participation/history may commit partially");
    assert(after.stats["red-1"].wins === 2 && after.stats["blue-1"].losses === 1,
      "Stats must roll back");
    assert(red.wins === 2 && blue.losses === 1 && red.elo === 1000,
      "In-memory state must be unchanged");
  }
});

test("repeated and concurrent same-match saves commit participation, Elo and streaks once", async () => {
  const { game, red } = gameFixture();
  const fake = fakeStore();
  const [first, second] = await Promise.all([
    persistCompletedMatch(game, fake.store),
    persistCompletedMatch(game, fake.store),
  ]);
  const third = await persistCompletedMatch(game, fake.store);
  assert(first.id === second.id && second.id === third.id, "Same ID across concurrent/retry");
  const state = fake.state();
  assert(Object.keys(state.games).length === 1, "Only one game");
  assert(state.participations.length === 2 && state.histories.length === 2,
    "Only one participation and Elo history per player");
  assert(state.stats["red-1"].wins === 3 && state.stats["blue-1"].losses === 2,
    "Statistics must be incremented once");
  assert(state.stats["red-1"].winStreak === 3, "Streak must increment once");
  assert(red.winStreak === 2 && red.elo === 1000,
    "In-memory state is not advanced by commit");
});

test("lost acknowledgement after match commit resolves by stored fingerprint, never reapplies", async () => {
  const { game } = gameFixture();
  const fake = fakeStore();
  fake.failAfterCommit();
  const result = await persistCompletedMatch(game, fake.store);
  assert(result.id === game.gameId, "Committed match detected after acknowledgement loss");
  const again = await persistCompletedMatch(game, fake.store);
  assert(again.id === result.id, "Identical retry is recognised");
  assert(fake.state().participations.length === 2, "No duplicate writes on retry");
});

test("unknown commit status stays unresolved when confirmation read fails", async () => {
  const { game } = gameFixture();
  const fake = fakeStore();
  fake.failAfterCommit();
  fake.failConfirmationRead();
  let uncertain = false;
  try {
    await persistCompletedMatch(game, fake.store);
  } catch (error) {
    uncertain = error instanceof MatchCommitUncertainError &&
      error.matchId === game.gameId;
  }
  assert(uncertain, "Unknown commit status requires operator inspection");
  assert(fake.state().participations.length === 2,
    "A lost acknowledgement must not be interpreted as rollback");
});

test("stale stats and conflicting saved payloads are rejected without overwrites", async () => {
  const { game } = gameFixture();
  const fake = fakeStore();
  game.teams.RED[0].wins = 99;
  let staleRejected = false;
  try { await persistCompletedMatch(game, fake.store); } catch { staleRejected = true; }
  assert(staleRejected && !Object.keys(fake.state().games).length, "Stale snapshot rejected");
  game.teams.RED[0].wins = 2;
  await persistCompletedMatch(game, fake.store);
  game.gameWinner = Team.BLUE;
  let conflictRejected = false;
  try { await persistCompletedMatch(game, fake.store); } catch { conflictRejected = true; }
  assert(conflictRejected && fake.state().stats["red-1"].wins === 3,
    "Existing result cannot be replaced by a different winner");
});

test("missing default season stats are created within the match transaction", async () => {
  const { game, blue } = gameFixture();
  Object.assign(blue, {
    elo: 1000, wins: 0, losses: 0, winStreak: 0, loseStreak: 0,
    biggestWinStreak: 0, biggestLosingStreak: 0,
  });
  const fake = fakeStore("blue-1");
  fake.failAt(1);
  let failed = false;
  try { await persistCompletedMatch(game, fake.store); }
  catch { failed = true; }
  assert(failed && !fake.state().stats["blue-1"],
    "Failed stats initialization must not persist outside transaction");
  fake.failAt(0);
  await persistCompletedMatch(game, fake.store);
  assert(fake.state().stats["blue-1"].losses === 1,
    "New season stats must be initialized then applied only once");
  await persistCompletedMatch(game, fake.store);
  assert(fake.state().stats["blue-1"].losses === 1,
    "Retry must not initialize or increment a second time");
});

test("unrated game records statistics but does not create Elo history", async () => {
  const { game } = gameFixture();
  game.noElo = true;
  const fake = fakeStore();
  await persistCompletedMatch(game, fake.store);
  assert(fake.state().participations.length === 2, "Participation saved");
  assert(fake.state().histories.length === 0, "No unrated Elo history");
  assert(fake.state().stats["red-1"].elo === 1000, "Unrated Elo unchanged");
});
