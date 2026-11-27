import { randomUUID } from "crypto";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { ConfigManager } from "../../src/ConfigManager";
import { prismaClient } from "../../src/database/prismaClient";
import { EventService, eventService } from "../../src/logic/EventService";
import {
  startEventDiscordSync,
  syncEventDiscord,
  syncReturningEventMember,
} from "../../src/logic/EventDiscordSync";

async function withSyncFixture(run: (f: any) => Promise<void>) {
  const db = prismaClient as any;
  const originals = {
    eventSignup: db.eventSignup,
    eventGuildState: db.eventGuildState,
    reconcile: eventService.reconcile,
  };
  const roles = ConfigManager.getConfig().roles;
  const oldRole = roles.eventParticipantRole;
  roles.eventParticipantRole = "event-role";
  let stamp = 10;
  const events: Record<string, any> = {
    old: { guildId: "guild", state: "FINISHED", title: "Old Cup" },
    older: { guildId: "guild", state: "FINISHED", title: "Older Cup" },
    current: { guildId: "guild", state: "OPEN", title: "Current Cup" },
    next: { guildId: "guild", state: "OPEN", title: "Next Cup" },
    foreign: { guildId: "other", state: "OPEN", title: "Other Cup" },
  };
  const makeRow = (
    id: string,
    eventId: string,
    user: string,
    status: string
  ) => ({
    id,
    eventId,
    discordUserId: user,
    status,
    updatedAt: new Date(++stamp),
    roleSyncPending: true,
    roleSyncToken: randomUUID(),
    promotionPending: false,
    promotionToken: null as string | null,
  });
  const rows = [
    makeRow("old-a", "old", "a", "WITHDRAWN"),
    makeRow("older-a", "older", "a", "CONFIRMED"),
    makeRow("current-a", "current", "a", "CONFIRMED"),
    makeRow("foreign-a", "foreign", "a", "CONFIRMED"),
  ];
  const f: any = {
    rows,
    events,
    makeRow,
    current: "current",
    fetches: [],
    operations: [],
    lookups: 0,
    guildFetches: 0,
    acknowledgements: 0,
    notifications: 0,
    reconciles: 0,
    missing: false,
    fail: false,
    onRole: undefined,
    onUserFetch: undefined,
    onSend: undefined,
    sameTimestamp: false,
    change: (row: any, data: any) => {
      Object.assign(row, data, {
        updatedAt: f.sameTimestamp ? row.updatedAt : new Date(++stamp),
        ...(data.roleSyncPending === true && !data.roleSyncToken
          ? { roleSyncToken: randomUUID() } : {}),
        ...(data.promotionPending === true && !data.promotionToken
          ? { promotionToken: randomUUID() } : {}),
      });
    },
  };
  eventService.reconcile = async () => {
    f.reconciles++;
  };
  db.eventGuildState = {
    findUnique: async ({ where }: any) => ({
      currentEventId: where.guildId === "guild" ? f.current : "foreign",
    }),
  };
  const matches = (row: any, where: any): boolean => {
    return Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === "OR") return value.some((part: any) => matches(row, part));
      if (key === "event") return matches(events[row.eventId], value);
      if (value instanceof Date) return +row[key] === +value;
      if (value && typeof value === "object") {
        if ("isSet" in value) return (row[key] !== undefined) === value.isSet;
        if ("in" in value) return value.in.includes(row[key]);
      }
      return row[key] === value;
    });
  };
  db.eventSignup = {
    findFirst: async ({ where }: any) => {
      const row = rows.find((r) => matches(r, where));
      return row ? { ...row, event: { ...events[row.eventId] } } : null;
    },
    findMany: async ({ where, select }: any) => {
      assert(!select.answers, "sync must not retrieve application answers");
      return rows
        .filter(
          (row) =>
            events[row.eventId].guildId === where.event.guildId &&
            (where.roleSyncPending ? row.roleSyncPending : row.promotionPending)
        )
        .map((row) => ({ ...row, event: { ...events[row.eventId] } }));
    },
    findUnique: async ({ where }: any) => {
      f.lookups++;
      const key = where.eventId_discordUserId;
      const row = rows.find(
        (r) =>
          r.eventId === key.eventId && r.discordUserId === key.discordUserId
      );
      return row ? { ...row, event: { ...events[row.eventId] } } : null;
    },
    updateMany: async ({ where, data }: any) => {
      if (data.roleSyncPending === false) f.acknowledgements++;
      const matching = rows.filter((row) => matches(row, where));
      matching.forEach((row) => f.change(row, data));
      return { count: matching.length };
    },
  };
  f.client = {
    guilds: {
      cache: new Map([["guild", {}]]),
      fetch: async (guildId: string) => {
        f.guildFetches++;
        return {
          members: {
            fetch: async ({ user: userId, force }: { user: string; force: boolean }) => {
              assert(force, "member fetch must bypass stale membership cache");
              f.fetches.push([guildId, userId]);
              if (f.missing) throw { code: 10007 };
              const apply = async (operation: string) => {
                f.operations.push([guildId, userId, operation]);
                if (f.fail) throw new Error("Discord unavailable");
                await f.onRole?.(userId);
              };
              return {
                roles: {
                  add: async () => apply("add"),
                  remove: async () => apply("remove"),
                },
              };
            },
          },
        };
      },
    },
    users: {
      fetch: async () => {
        await f.onUserFetch?.();
        return {
          send: async () => {
            await f.onSend?.();
            f.notifications++;
          },
        };
      },
    },
  };
  try {
    await run(f);
  } finally {
    db.eventSignup = originals.eventSignup;
    db.eventGuildState = originals.eventGuildState;
    eventService.reconcile = originals.reconcile;
    roles.eventParticipantRole = oldRole;
  }
}

test("event sync groups historical signups, respects current authority and guild isolation", async () => {
  await withSyncFixture(async (f) => {
    f.rows[2].promotionPending = true;
    await syncEventDiscord(f.client, "guild");
    assertEqual(f.fetches.length, 1, "one member fetch for three signups");
    assertEqual(f.lookups, 1, "one current confirmation lookup");
    assertEqual(f.acknowledgements, 1, "one conditional acknowledgement");
    assertEqual(f.operations[0][2], "add", "current confirmation wins");
    assert(
      f.rows.slice(0, 3).every((r: any) => !r.roleSyncPending),
      "guild rows acknowledged"
    );
    assert(f.rows[3].roleSyncPending, "other guild untouched");
    assertEqual(f.notifications, 1, "promotion DM sent once");
    await syncEventDiscord(f.client, "guild");
    assertEqual(f.guildFetches, 1, "idle pass avoids Discord guild fetch");
    assertEqual(f.notifications, 1, "promotion is not repeated");
    f.events.current.state = "FINISHED";
    f.change(f.rows[2], { roleSyncPending: true });
    await syncEventDiscord(f.client, "guild");
    assertEqual(f.operations[1][2], "remove", "finished event removes role");
  });
});

test("event sync retries failed roles, restores returning members and preserves concurrent versions", async () => {
  await withSyncFixture(async (f) => {
    f.fail = true;
    await syncEventDiscord(f.client, "guild");
    assert(
      f.rows.slice(0, 3).every((r: any) => r.roleSyncPending),
      "failed role keeps all pending"
    );
    f.fail = false;
    f.onRole = async () => {
      f.change(f.rows[2], { status: "WITHDRAWN", roleSyncPending: true });
      await syncEventDiscord(f.client, "guild");
    };
    await syncEventDiscord(f.client, "guild");
    assert(f.rows[2].roleSyncPending, "concurrent withdrawal not acknowledged");
    assertEqual(
      f.operations.length,
      2,
      "overlapping sync cannot duplicate role operation"
    );
    f.onRole = undefined;
    await syncEventDiscord(f.client, "guild");
    assertEqual(
      f.operations[2][2],
      "remove",
      "retry applies new desired state"
    );
    f.change(f.rows[2], { status: "CONFIRMED", roleSyncPending: true });
    f.missing = true;
    await syncEventDiscord(f.client, "guild");
    assert(
      !f.rows[2].roleSyncPending,
      "known absent member safely acknowledged"
    );
    f.missing = false;
    await syncReturningEventMember(f.client, "guild", "a");
    assertEqual(
      f.operations[3][2],
      "add",
      "returning member role restored once"
    );
    assert(
      f.rows[3].roleSyncPending,
      "returning member update is guild scoped"
    );
  });
});

test("event sync refreshes current event authority for each member and retains new pending rows", async () => {
  await withSyncFixture(async (f) => {
    f.rows.push(f.makeRow("old-b", "old", "b", "CONFIRMED"));
    f.onRole = async (userId: string) => {
      if (userId !== "a") return;
      f.events.current.state = "FINISHED";
      f.current = "next";
      f.change(f.rows[2], { roleSyncPending: true });
      f.rows.push(f.makeRow("next-a", "next", "a", "RESERVE"));
      f.rows.push(f.makeRow("next-b", "next", "b", "CONFIRMED"));
    };
    await syncEventDiscord(f.client, "guild");
    assertEqual(
      f.operations[1][2],
      "add",
      "second member uses replacement event"
    );
    assert(
      f.rows.find((r: any) => r.id === "next-b").roleSyncPending,
      "new rows not acknowledged by old snapshot"
    );
    f.onRole = undefined;
    await syncEventDiscord(f.client, "guild");
    assertEqual(
      f.operations[2][2],
      "remove",
      "new reserve has no participant role"
    );
    assertEqual(f.operations[3][2], "add", "new confirmation retained");
  });
});

test("same-timestamp role changes survive grouped acknowledgement, including legacy rows", async () => {
  await withSyncFixture(async (f) => {
    delete f.rows[0].roleSyncToken;
    f.rows[1].roleSyncToken = null;
    f.sameTimestamp = true;
    f.onRole = async () => {
      f.change(f.rows[2], { status: "WITHDRAWN", roleSyncPending: true });
    };
    await syncEventDiscord(f.client, "guild");
    assert(!f.rows[0].roleSyncPending && !f.rows[1].roleSyncPending, "legacy rows acknowledged");
    assert(f.rows[2].roleSyncPending, "same-timestamp withdrawal survives");
    f.onRole = undefined;
    await syncEventDiscord(f.client, "guild");
    assertEqual(f.operations[1][2], "remove", "retry corrects role");
    assert(!f.rows[2].roleSyncPending, "new token acknowledged");
  });
});

test("same-timestamp returning member is not acknowledged by earlier work", async () => {
  await withSyncFixture(async (f) => {
    f.sameTimestamp = true;
    f.onRole = async () => {
      await syncReturningEventMember(f.client, "guild", "a");
    };
    await syncEventDiscord(f.client, "guild");
    assert(f.rows.slice(0, 3).every((row: any) => row.roleSyncPending), "rejoin replaces every captured token");
    f.onRole = undefined;
    await syncEventDiscord(f.client, "guild");
    assert(f.rows.slice(0, 3).every((row: any) => !row.roleSyncPending), "fresh role work acknowledged on retry");
    assertEqual(f.operations.length, 2, "one grouped operation per pass");
  });
});

test("promotion retries transient failures, skips withdrawn snapshots and handles disabled DMs", async () => {
  await withSyncFixture(async (f) => {
    const row = f.rows[2];
    f.change(row, { promotionPending: true });
    f.onSend = async () => { throw new Error("temporary network error"); };
    await syncEventDiscord(f.client, "guild");
    assert(row.promotionPending, "temporary failure retained");
    f.onSend = async () => { f.change(row, { minecraftUsername: "Renamed" }); };
    await syncEventDiscord(f.client, "guild");
    assert(!row.promotionPending, "unrelated edit cannot invalidate promotion acknowledgement");
    assertEqual(f.notifications, 1, "one delivery");
    f.change(row, { promotionPending: true });
    f.onUserFetch = async () => { f.change(row, { status: "WITHDRAWN", promotionPending: false }); };
    await syncEventDiscord(f.client, "guild");
    assertEqual(f.notifications, 1, "withdrawal during user fetch suppresses stale notification");
    f.onUserFetch = undefined;
    f.change(row, { status: "CONFIRMED", promotionPending: true });
    f.onSend = async () => { throw { code: 50007 }; };
    await syncEventDiscord(f.client, "guild");
    assert(!row.promotionPending, "disabled DMs are terminal");
  });
});

test("event maintenance starts once and skips overlapping guild work", async () => {
  await withSyncFixture(async (f) => {
    const previous = global.setInterval;
    let tick: () => void = () => {};
    let timers = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    eventService.reconcile = async () => {
      f.reconciles++;
      await gate;
    };
    (global as any).setInterval = (fn: () => void) => {
      timers++;
      tick = fn;
      return { unref() {} };
    };
    try {
      startEventDiscordSync(f.client);
      startEventDiscordSync(f.client);
      tick();
      assertEqual(timers, 1, "one timer per client");
      assertEqual(f.reconciles, 1, "overlapping ticks skipped");
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assertEqual(f.reconciles, 2, "maintenance resumes after completion");
    } finally {
      release();
      global.setInterval = previous;
    }
  });
});

test("a stalled guild does not block another guild on the next maintenance tick", async () => {
  await withSyncFixture(async (f) => {
    const previous = global.setInterval;
    let tick: () => void = () => {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const visited: string[] = [];
    f.client.guilds.cache = new Map([["slow", {}], ["other", {}]]);
    eventService.reconcile = async (id: string) => {
      visited.push(id);
      if (id === "slow") await gate;
    };
    (global as any).setInterval = (fn: () => void) => {
      tick = fn;
      return { unref() {} };
    };
    try {
      startEventDiscordSync(f.client);
      tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assertEqual(visited.join(","), "slow,other", "healthy guild processed while slow guild is blocked");
    } finally {
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      global.setInterval = previous;
    }
  });
});

test("idle event reconciliation avoids writes and rechecks capacity under lock", async () => {
  const event: any = {
    id: "event",
    guildId: "guild",
    revision: 0,
    state: "OPEN",
    capacity: 1,
    signupDeadline: null,
  };
  let reserves = 0;
  let confirmed = 1;
  let locks = 0;
  let promotions = 0;
  let changeBeforeLock = false;
  const db: any = {
    eventGuildState: { findUnique: async () => ({ currentEventId: event.id }) },
    standaloneEvent: {
      findFirst: async () => ({ ...event }),
      updateMany: async () => {
        locks++;
        return { count: 1 };
      },
    },
    eventSignup: {
      findFirst: async () => (reserves ? { id: "first" } : null),
      count: async () => confirmed,
      findMany: async ({ take, select, orderBy }: any) => {
        assertEqual(take, 1, "database fetch limited to available places");
        assertEqual(
          Object.keys(select).join(","),
          "id",
          "only reserve IDs fetched"
        );
        assertEqual(
          JSON.stringify(orderBy),
          JSON.stringify([{ queuedAt: "asc" }, { id: "asc" }]),
          "stable FIFO"
        );
        return [{ id: "first" }];
      },
      updateMany: async () => {
        promotions++;
        return { count: 1 };
      },
    },
    $transaction: async (run: any) => {
      if (changeBeforeLock) confirmed = 1;
      return run(db);
    },
  };
  const service = new EventService(db);
  await service.reconcile("guild");
  reserves = 2;
  await service.reconcile("guild");
  assertEqual(locks, 0, "no reserve or no space avoids revision writes");
  confirmed = 0;
  changeBeforeLock = true;
  await service.reconcile("guild");
  assertEqual(promotions, 0, "concurrent capacity change prevents promotion");
  confirmed = 0;
  changeBeforeLock = false;
  await service.reconcile("guild");
  assertEqual(promotions, 1, "eligible reserve is promoted");
});
