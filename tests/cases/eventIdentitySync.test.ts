import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { EventService } from "../../src/logic/EventService";
import { updatePlayerIdentityAndEventSignups } from "../../src/logic/EventIdentitySync";
import { MojangAPI } from "../../src/api/MojangAPI";
import { prismaClient } from "../../src/database/prismaClient";

const primary = "a".repeat(32);
const replacement = "b".repeat(32);

test("event rosters use the linked identity for active applications but retain finished and withdrawn snapshots", async () => {
  const event = { id: "event", guildId: "guild", state: "OPEN" };
  const rows = [
    {
      id: "current",
      discordUserId: "user",
      status: "CONFIRMED",
      minecraftUUID: primary,
      minecraftUsername: "BeforeUpdate",
    },
    {
      id: "reserve",
      discordUserId: "user2",
      status: "RESERVE",
      minecraftUUID: primary,
      minecraftUsername: "BeforeReserveUpdate",
    },
    {
      id: "withdrawn",
      discordUserId: "user",
      status: "WITHDRAWN",
      minecraftUUID: primary,
      minecraftUsername: "WithdrawnName",
    },
  ] as any[];
  let playerQueries = 0;
  const db: any = {
    standaloneEvent: {
      findFirst: async () => event,
    },
    eventSignup: {
      findMany: async () => rows.map((row) => ({ ...row })),
    },
    player: {
      findMany: async ({ where }: any) => {
        playerQueries++;
        assert(
          where.discordSnowflake.in.includes("user"),
          "looks up linked Discord identities"
        );
        return [
          {
            discordSnowflake: "user",
            primaryMinecraftAccount: replacement,
            latestIGN: "CurrentName",
          },
          {
            discordSnowflake: "user2",
            primaryMinecraftAccount: primary,
            latestIGN: "ReserveName",
          },
        ];
      },
    },
  };
  const service = new EventService(db);
  const live = await service.roster("guild", "event");
  assertEqual(
    live[0].minecraftUUID,
    replacement,
    "active roster sees new UUID"
  );
  assertEqual(
    live[0].minecraftUsername,
    "CurrentName",
    "active roster sees new IGN"
  );
  assertEqual(
    live[1].minecraftUsername,
    "ReserveName",
    "reserves also see current IGN"
  );
  assertEqual(
    live[2].minecraftUsername,
    "WithdrawnName",
    "withdrawn history stays intact"
  );
  assertEqual(
    rows[0].minecraftUsername,
    "BeforeUpdate",
    "roster lookup does not rewrite snapshots"
  );

  event.state = "CLOSED";
  const closed = await service.roster("guild", "event");
  assertEqual(
    closed[0].minecraftUsername,
    "CurrentName",
    "closed current event still follows identity"
  );

  event.state = "FINISHED";
  const historical = await service.roster("guild", "event");
  assertEqual(
    historical[0].minecraftUsername,
    "BeforeUpdate",
    "finished history retains original IGN"
  );
  assertEqual(playerQueries, 2, "finished event does not query live identity");
});

test("event signup cannot roll a linked player's updated username back to a supplied old alias", async () => {
  const oldLookup = MojangAPI.usernameToUUID;
  (MojangAPI as any).usernameToUUID = async () => primary;
  const event = {
    id: "event",
    guildId: "guild",
    state: "OPEN",
    revision: 0,
    formRevision: 0,
    capacity: null,
    signupDeadline: null,
    questions: [],
  };
  const linked = {
    discordSnowflake: "user",
    primaryMinecraftAccount: primary,
    latestIGN: "CurrentName",
    minecraftAccounts: ["BeforeUpdate"],
  };
  let changedPlayer = 0;
  let signup: any;
  const db: any = {
    player: {
      findUnique: async () => linked,
      findFirst: async () => null,
      upsert: async () => {
        changedPlayer++;
        throw new Error("must not write existing Player");
      },
    },
    standaloneEvent: {
      findFirst: async () => event,
      updateMany: async () => ({ count: 1 }),
    },
    eventGuildState: { findUnique: async () => ({ currentEventId: "event" }) },
    eventSignup: {
      findUnique: async () => null,
      findMany: async () => [],
      count: async () => 0,
      upsert: async ({ create }: any) => {
        signup = create;
        return create;
      },
    },
    $transaction: async (op: any) => op(db),
  };

  try {
    const service = new EventService(db);
    const result = await service.signup("guild", "event", "user", {
      answers: {},
      formRevision: 0,
      acceptedTerms: true,
      minecraftUsername: "BeforeUpdate",
    });
    assertEqual(
      result.minecraftUsername,
      "CurrentName",
      "signup uses canonical linked IGN"
    );
    assertEqual(signup.minecraftUUID, primary, "signup uses linked UUID");
    assertEqual(linked.latestIGN, "CurrentName", "player stays canonical");
    assertEqual(
      changedPlayer,
      0,
      "event signup never updates existing linked player"
    );
  } finally {
    (MojangAPI as any).usernameToUUID = oldLookup;
  }
});

test("unlinked event form requires fresh verification and cannot silently switch UUID", async () => {
  const original = MojangAPI.usernameToUUID;
  let resolved: string | null = primary;
  let transactions = 0;
  const db: any = {
    player: { findUnique: async () => null, findFirst: async () => null },
    $transaction: async () => { transactions++; throw new Error("unexpected write"); },
  };
  try {
    MojangAPI.usernameToUUID = async (_name, fresh) => {
      assert(fresh === true, "always verify current name ownership");
      return resolved;
    };
    const service = new EventService(db);
    const verified = await service.identity("user", "OriginalName");
    const application = { answers: {}, formRevision: 0, acceptedTerms: true,
      minecraftUsername: verified.username, expectedMinecraftUUID: verified.uuid };
    for (const [next, message] of [[null, "Could not verify"], [replacement, "account changed"]] as const) {
      resolved = next;
      let rejected = false;
      try { await service.signup("guild", "event", "user", application); }
      catch (error) { rejected = String(error).includes(message); }
      assert(rejected, "invalid identity evidence prevents submission");
    }
    assertEqual(transactions, 0, "verification failure never reaches writes");
  } finally {
    MojangAPI.usernameToUUID = original;
  }
});

test("an event form started before an account switch cannot overwrite the new linked account", async () => {
  let reads = 0;
  let signups = 0;
  const db: any = {
    player: {
      findUnique: async () => ({
        primaryMinecraftAccount: reads++ === 0 ? primary : replacement,
        latestIGN: reads === 1 ? "BeforeUpdate" : "CurrentName",
      }),
      findFirst: async () => null,
      upsert: async () => {
        throw new Error("must not update player");
      },
    },
    standaloneEvent: {
      findFirst: async () => ({
        id: "event",
        guildId: "guild",
        state: "OPEN",
        revision: 0,
        formRevision: 0,
        questions: [],
      }),
      updateMany: async () => ({ count: 1 }),
    },
    eventGuildState: { findUnique: async () => ({ currentEventId: "event" }) },
    eventSignup: {
      upsert: async () => {
        signups++;
      },
    },
    $transaction: async (op: any) => op(db),
  };
  let rejected = false;
  try {
    await new EventService(db).signup("guild", "event", "user", {
      answers: {},
      formRevision: 0,
      acceptedTerms: true,
      minecraftUsername: "BeforeUpdate",
    });
  } catch (error) {
    rejected = String(error).includes("linked Minecraft account changed");
  }
  assert(rejected, "stale account changes force a fresh form");
  assertEqual(signups, 0, "stale form cannot create or edit a signup");
});

test("username identity mutation updates live signups atomically and preserves history", async () => {
  const db = prismaClient as any;
  const originalTransaction = db.$transaction;
  const player = {
    id: "player",
    discordSnowflake: "user",
    primaryMinecraftAccount: primary,
    latestIGN: "BeforeUpdate",
  };
  const rows = [
    {
      discordUserId: "user",
      eventId: "open",
      state: "OPEN",
      status: "CONFIRMED",
      minecraftUsername: "BeforeUpdate",
      minecraftUUID: primary,
    },
    {
      discordUserId: "user",
      eventId: "closed",
      state: "CLOSED",
      status: "RESERVE",
      minecraftUsername: "BeforeUpdate",
      minecraftUUID: primary,
    },
    {
      discordUserId: "user",
      eventId: "finished",
      state: "FINISHED",
      status: "CONFIRMED",
      minecraftUsername: "Historical",
      minecraftUUID: primary,
    },
    {
      discordUserId: "user",
      eventId: "open",
      state: "OPEN",
      status: "WITHDRAWN",
      minecraftUsername: "Withdrawn",
      minecraftUUID: primary,
    },
    {
      discordUserId: "other",
      eventId: "open",
      state: "OPEN",
      status: "CONFIRMED",
      minecraftUsername: "Other",
      minecraftUUID: primary,
    },
  ];
  let failSync = false;
  let conflictingOwner = false;
  db.$transaction = async (callback: any) => {
    // Commit only when every operation succeeds, matching Mongo transactions.
    const pendingPlayer = { ...player };
    const pendingRows = rows.map((row) => ({ ...row }));
    const tx = {
      player: {
        findFirst: async ({ where }: any) => {
          assertEqual(where.NOT.id, player.id, "Recheck excludes original owner");
          assertEqual(where.OR[0].primaryMinecraftAccount.mode, "insensitive", "Recheck catches differently cased UUID ownership");
          return conflictingOwner ? { id: "concurrent-owner" } : null;
        },
        updateMany: async ({ where, data }: any) => {
          if (
            where.id !== pendingPlayer.id ||
            where.primaryMinecraftAccount !==
              pendingPlayer.primaryMinecraftAccount ||
            where.latestIGN !== pendingPlayer.latestIGN
          )
            return { count: 0 };
          Object.assign(pendingPlayer, data);
          return { count: 1 };
        },
      },
      standaloneEvent: {
        findMany: async ({ where }: any) => {
          assertEqual(
            where.state.in.join(","),
            "OPEN,CLOSED",
            "only currently open or closed events are selected"
          );
          return [{ id: "open" }, { id: "closed" }];
        },
      },
      eventSignup: {
        updateMany: async ({ where, data }: any) => {
          assertEqual(
            where.discordUserId,
            "user",
            "scope by the player Discord ID"
          );
          assertEqual(
            where.status.in.join(","),
            "CONFIRMED,RESERVE",
            "only active applications"
          );
          assertEqual(
            where.eventId.in.join(","),
            "open,closed",
            "only live event IDs"
          );
          if (failSync) throw new Error("Event sync failed");
          let updated = 0;
          for (const row of pendingRows) {
            if (
              row.discordUserId === where.discordUserId &&
              where.status.in.includes(row.status) &&
              where.eventId.in.includes(row.eventId)
            ) {
              Object.assign(row, data);
              updated++;
            }
          }
          return { count: updated };
        },
      },
    };
    const result = await callback(tx);
    Object.assign(player, pendingPlayer);
    pendingRows.forEach((row, index) => Object.assign(rows[index], row));
    return result;
  };
  try {
    conflictingOwner = true;
    let conflictRejected = false;
    try {
      await updatePlayerIdentityAndEventSignups(player, primary, replacement, "CurrentName");
    } catch (error) {
      conflictRejected = String(error).includes("already linked");
    }
    assert(conflictRejected, "Late ownership conflict rejects organiser identity mutation");
    assertEqual(player.primaryMinecraftAccount, primary, "Conflicting claim cannot change canonical identity");
    assertEqual(rows[0].minecraftUUID, primary, "Conflicting claim cannot change live signup");
    conflictingOwner = false;
    failSync = true;
    let failed = false;
    try {
      await updatePlayerIdentityAndEventSignups(
        player,
        primary,
        replacement,
        "CurrentName"
      );
    } catch {
      failed = true;
    }
    assert(failed, "sync failure rejects the identity mutation");
    assertEqual(
      player.primaryMinecraftAccount,
      primary,
      "failed sync cannot commit player"
    );
    assertEqual(
      rows[0].minecraftUsername,
      "BeforeUpdate",
      "failed sync cannot commit signup"
    );

    failSync = false;
    const updated = await updatePlayerIdentityAndEventSignups(
      player,
      primary,
      replacement,
      "CurrentName"
    );
    assertEqual(updated.count, 1, "identity updated");
    assertEqual(
      player.primaryMinecraftAccount,
      replacement,
      "canonical UUID changed"
    );
    assertEqual(rows[0].minecraftUUID, replacement, "confirmed event synced");
    assertEqual(
      rows[1].minecraftUsername,
      "CurrentName",
      "reserve event synced"
    );
    assertEqual(
      rows[2].minecraftUsername,
      "Historical",
      "finished signup untouched"
    );
    assertEqual(
      rows[3].minecraftUsername,
      "Withdrawn",
      "withdrawn signup untouched"
    );
    assertEqual(
      rows[4].minecraftUsername,
      "Other",
      "other Discord member untouched"
    );

    const stale = await updatePlayerIdentityAndEventSignups(
      {
        ...player,
        primaryMinecraftAccount: primary,
        latestIGN: "BeforeUpdate",
      },
      primary,
      "c".repeat(32),
      "Stale"
    );
    assertEqual(stale.count, 0, "stale identity compare-and-swap fails");
    assertEqual(
      rows[0].minecraftUsername,
      "CurrentName",
      "stale update does not touch signups"
    );
  } finally {
    db.$transaction = originalTransaction;
  }
});
