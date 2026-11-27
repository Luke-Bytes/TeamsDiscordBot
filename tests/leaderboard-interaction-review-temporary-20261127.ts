import { strict as assert } from "node:assert";
import { EmbedBuilder, MessageFlags } from "discord.js";
import { SeasonType } from "@prisma/client";
import LeaderboardsCommand from "../src/commands/LeaderboardsCommand";
import { LeaderBoardFeed } from "../src/logic/gameFeed/LeaderBoardFeed";
import { prismaClient } from "../src/database/prismaClient";
import { SeasonService } from "../src/database/SeasonService";
import { Channels } from "../src/Channels";
import { AiAdmission } from "../src/ai/Admission";
import { InteractionGuard } from "../src/util/InteractionGuard";
import { CommandHandler } from "../src/commands/CommandHandler";
import { GameRecoveryCoordinator } from "../src/logic/ActiveGameRecovery";
import { createChatInputInteraction } from "./framework/mocks";
import { test as registerTest } from "./framework/test";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const flush = () => new Promise<void>((r) => setImmediate(r));
const test = (name: string, fn: () => unknown) =>
  registerTest(name, async () => {
    const previousChannel = Channels.botCommands;
    const previousEnter = GameRecoveryCoordinator.enterOperation;
    (Channels as any).botCommands = { id: "commands" };
    GameRecoveryCoordinator.enterOperation = () => () => {};
    try {
      await fn();
    } finally {
      (Channels as any).botCommands = previousChannel;
      GameRecoveryCoordinator.enterOperation = previousEnter;
    }
  });
const opening = (id: string) => {
  const interaction: any = createChatInputInteraction("u", {
    channelId: "commands",
  });
  interaction.deferReply = async () => {
    interaction.deferred = true;
    return { interaction: { responseMessageId: id } };
  };
  return interaction;
};
const makeButton = (
  id: string,
  channel = "commands",
  user = "u",
  customId = "leaderboard_next"
) => {
  const i: any = {
    user: { id: user },
    message: { id },
    channelId: channel,
    customId,
    edits: [],
    replies: [],
    deferred: false,
    isButton: () => true,
    isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => false,
    isUserContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    inGuild: () => false,
    deferUpdate: async () => {
      i.deferred = true;
    },
    reply: async (p: any) => {
      i.replies.push(p);
    },
    followUp: async (p: any) => {
      i.replies.push(p);
    },
    editReply: async (p: any) => {
      i.edits.push(p);
    },
  };
  return i;
};
const setup = () => {
  const c: any = new LeaderboardsCommand();
  c.generateLeaderboardEmbed = async (page: number) => ({
    embed: new EmbedBuilder().setTitle("Board"),
    page: Math.max(0, Math.min(page, 4)),
    totalPages: 5,
  });
  return c;
};
const session = (c: any, channel = "commands", id = "board", user = "u") => {
  const s = c.startSession(user + "-" + channel);
  s.messageId = id;
  s.busy = false;
  return s;
};
const handler = (c: any) =>
  Object.assign(Object.create(CommandHandler.prototype), {
    commands: [c],
    leaderboardsCommand: c,
    interactionGuard: new InteractionGuard(),
  });
test("ranked and relaxed independent ordinal model, orphan rows, empty and exact multiples; feed agrees", async () => {
  const db: any = prismaClient,
    saved = [
      db.$transaction,
      db.playerStats.findMany,
      db.season.findUnique,
      SeasonService.requireActiveSeason,
    ];
  let rows: any[] = [],
    type: SeasonType = SeasonType.RANKED;
  const season = () => ({ id: "s", number: 9, type });
  const cmp = (a: any, b: any) =>
    (type === SeasonType.RANKED
      ? b.elo - a.elo
      : b.wins - a.wins || b.biggestWinStreak - a.biggestWinStreak) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const findMany = async (q: any) => {
    assert.equal(q.where.seasonId, "s");
    return [...rows]
      .sort((a, b) => {
        for (const k of q.orderBy) {
          const [key, dir] = Object.entries(k)[0];
          if (a[key] !== b[key])
            return (a[key] < b[key] ? -1 : 1) * (dir === "asc" ? 1 : -1);
        }
        return 0;
      })
      .slice(q.skip ?? 0, (q.skip ?? 0) + q.take);
  };
  db.season.findUnique = async (q: any) =>
    q.where.number === 9 ? season() : null;
  SeasonService.requireActiveSeason = async () => season() as any;
  db.playerStats.findMany = findMany;
  db.$transaction = async (fn: any) =>
    fn({
      playerStats: {
        findMany,
        count: async (q: any) =>
          q.where.OR
            ? rows.filter(
                (r) =>
                  r.elo > q.where.OR[0].elo.gt ||
                  (r.elo === q.where.OR[1].elo && r.id < q.where.OR[1].id.lt)
              ).length
            : rows.length,
        findUnique: async (q: any) =>
          rows.find((r) => r.playerId === q.where.playerId_seasonId.playerId) ??
          null,
      },
      player: {
        findUnique: async (q: any) => {
          const r = rows.find(
            (r) => r.player?.discordSnowflake === q.where.discordSnowflake
          );
          return r ? { id: r.playerId } : null;
        },
      },
    });
  try {
    const c: any = new LeaderboardsCommand();
    for (const n of [0, 1, 10, 20, 21, 37]) {
      rows = Array.from({ length: n }, (_, i) => ({
        id: String(100 + i),
        playerId: "p" + i,
        elo: i % 3 === 0 ? 1200 : 1000,
        wins: i % 4,
        losses: i % 5,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: i % 3,
        player:
          i % 7 === 0
            ? null
            : { latestIGN: "P" + i, discordSnowflake: "u" + i },
      })).reverse();
      for (const t of [SeasonType.RANKED, SeasonType.RELAXED]) {
        type = t;
        const sorted = [...rows].sort(cmp);
        const user = "u19";
        const ordinal = sorted.findIndex(
          (r) => r.player?.discordSnowflake === user
        );
        for (const requested of [-1, 0, 1, 2, 99]) {
          const result = await c.generateLeaderboardEmbed(requested, user, 9);
          const total = Math.max(1, Math.ceil(n / 10)),
            page = Math.max(0, Math.min(requested, total - 1));
          assert.equal(result.page, page);
          assert.equal(result.totalPages, total);
          const fields = result.embed.data.fields ?? [];
          const expected = sorted.slice(page * 10, page * 10 + 10);
          assert.equal(fields.length, expected.length);
          expected.forEach((r, i) =>
            assert.ok(
              fields[i].name.includes(
                "**" + (r.player?.latestIGN ?? "Unknown Player") + "**"
              )
            )
          );
          if (t === SeasonType.RANKED)
            assert.ok(
              result.embed.data.footer.text.includes(
                ordinal < 0 ? "Unranked" : "#" + (ordinal + 1) + " |"
              )
            );
        }
        const feed = await new LeaderBoardFeed().generateEmbed();
        const ff = feed.data.fields ?? [];
        assert.equal(ff.length, Math.min(n, 10));
        sorted
          .slice(0, 10)
          .forEach((r, i) =>
            assert.ok(
              ff[i].name.includes("**" + (r.player?.latestIGN ?? "N/A") + "**")
            )
          );
      }
    }
  } finally {
    [
      db.$transaction,
      db.playerStats.findMany,
      db.season.findUnique,
      SeasonService.requireActiveSeason,
    ] = saved;
  }
});
test("user-wide navigation throttle must hold across multiple channels", async () => {
  const c = setup();
  const h = handler(c);
  let calls = 0;
  const gate = deferred();
  const oldNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  c.generateLeaderboardEmbed = async () => {
    calls++;
    await gate.promise;
    return { embed: new EmbedBuilder(), page: 1, totalPages: 5 };
  };
  try {
    session(c, "c1", "b1");
    session(c, "c2", "b2");
    session(c, "c3", "b3");
    session(c, "c1", "other", "v");
    const first = h.handleInteraction(makeButton("b1", "c1"));
    await flush();
    now += 499;
    const second = makeButton("b2", "c2"),
      third = makeButton("b3", "c3");
    await Promise.all([
      h.handleInteraction(second),
      h.handleInteraction(third),
    ]);
    assert.equal(
      calls,
      1,
      "same user cannot run concurrent queries even across channels"
    );
    const other = h.handleInteraction(makeButton("other", "c1", "v"));
    await flush();
    assert.equal(calls, 2, "unrelated user can navigate independently");
    gate.resolve();
    await Promise.all([first, other]);
    const rapid = makeButton("b2", "c2");
    await h.handleInteraction(rapid);
    assert.equal(calls, 2, "cross-channel cooldown holds after completion");
    assert.equal(rapid.deferred, true);
    now++;
    await h.handleInteraction(makeButton("b2", "c2"));
    assert.equal(calls, 3, "exact 500ms boundary permits another navigation");
  } finally {
    gate.resolve();
    Date.now = oldNow;
  }
});
test("expired in-flight session must not revive itself after deadline", async () => {
  const c = setup(),
    s = session(c);
  const gate = deferred();
  let now = 1_800_000_000_000;
  const old = Date.now;
  Date.now = () => now;
  try {
    s.expiresAt = now + 1;
    c.generateLeaderboardEmbed = async () => {
      await gate.promise;
      return { embed: new EmbedBuilder(), page: 1, totalPages: 5 };
    };
    const i = makeButton("board");
    const p = c.handleButtonPress(i);
    await flush();
    now += 2;
    gate.resolve();
    await p;
    assert.equal(
      c.isOwnedNavigation(i),
      false,
      "expired session was refreshed"
    );
    assert.equal(i.edits.length, 0);
  } finally {
    gate.resolve();
    Date.now = old;
  }
});
test("capacity eviction should prefer idle session over busy opening", () => {
  const c = setup();
  const busy = c.startSession("busy");
  for (let i = 0; i < 999; i++) {
    const s = c.startSession("idle" + i);
    s.busy = false;
  }
  c.startSession("new");
  assert.equal(
    c.userStates.get("busy"),
    busy,
    "busy opening evicted despite 999 idle sessions"
  );
  assert.equal(
    c.userStates.has("idle0"),
    false,
    "oldest idle session is evicted"
  );
  assert.equal(c.userStates.size, 1000);
});
test("all busy sessions reject a new opening without allocating or querying", async () => {
  const c = setup();
  let calls = 0;
  c.generateLeaderboardEmbed = async () => {
    calls++;
    throw new Error("Unexpected query");
  };
  for (let i = 0; i < 1000; i++) c.startSession("busy" + i);
  const i = opening("new");
  await c.execute(i);
  assert.equal(calls, 0);
  assert.equal(c.userStates.size, 1000);
  assert.equal(i.replies[0].payload.flags, MessageFlags.Ephemeral);
  assert.match(i.replies[0].payload.content, /busy/);
});
test("navigation lock survives session replacement and is reclaimed", async () => {
  const c = setup();
  const gate = deferred();
  const oldNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  let calls = 0;
  c.generateLeaderboardEmbed = async () => {
    calls++;
    await gate.promise;
    return { embed: new EmbedBuilder(), page: 1, totalPages: 5 };
  };
  try {
    const oldSession = session(c);
    const old = makeButton("board");
    const pending = c.handleButtonPress(old);
    await flush();
    const replacement = session(c, "commands", "replacement");
    now += 600;
    await c.handleButtonPress(makeButton("replacement"));
    assert.equal(
      calls,
      1,
      "replacing session cannot release an in-flight user lock"
    );
    gate.resolve();
    await pending;
    assert.equal(old.edits.length, 0);
    assert.equal(oldSession.busy, false);
    assert.equal(c.userStates.get("u-commands"), replacement);
    await c.handleButtonPress(makeButton("replacement"));
    assert.equal(calls, 2);
    assert.equal(replacement.currentPage, 1);
    now += 500;
    c.startSession("other");
    assert.equal(
      c.navigationByUser.size,
      0,
      "inactive navigation timestamp cleaned on later opening"
    );
  } finally {
    gate.resolve();
    Date.now = oldNow;
  }
});
test("expiry during message edit clears controls without reviving session", async () => {
  const c = setup(),
    s = session(c);
  const gate = deferred();
  const oldNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    s.expiresAt = now + 1;
    const i = makeButton("board");
    i.editReply = async (p: any) => {
      i.edits.push(p);
      await gate.promise;
    };
    const pending = c.handleButtonPress(i);
    await flush();
    assert.equal(i.edits.length, 1);
    now++;
    gate.resolve();
    await pending;
    assert.equal(c.userStates.size, 0);
    assert.equal(i.edits.length, 2);
    assert.deepEqual(i.edits[1], { components: [] });
    assert.equal(s.currentPage, 0);
  } finally {
    gate.resolve();
    Date.now = oldNow;
  }
});
test("deletion before initial edit response must not leave an owned session", async () => {
  const c = setup();
  const i = opening("board");
  i.editReply = async () => {
    c.removeMessageSession("board");
    return { id: "board" };
  };
  await c.execute(i);
  assert.equal(
    c.userStates.size,
    0,
    "delete event occurred during initial edit"
  );
});
test("old opening completing its Discord edit after replacement must not expose stale controls", async () => {
  const c = setup(),
    gate = deferred();
  const first = opening("old"),
    second = opening("new");
  const edits: any[] = [];
  first.editReply = async (p: any) => {
    edits.push(p);
    await gate.promise;
    return { id: "old" };
  };
  second.editReply = async () => ({ id: "new" });
  const pending = c.execute(first);
  try {
    await flush();
    assert.equal(
      edits[0].components.length,
      1,
      "initial edit was in flight with controls"
    );
    await c.execute(second);
  } finally {
    gate.resolve();
    await pending;
  }
  assert.equal(c.userStates.get("u-commands").messageId, "new");
  assert.deepEqual(
    edits[1],
    { components: [] },
    "superseded message receives a control-only cleanup edit"
  );
});
test("failed private follow-up must not fall back to public board edit", async () => {
  const c = setup(),
    h = handler(c);
  const s = session(c);
  c.generateLeaderboardEmbed = async () => {
    throw new Error("offline query failure");
  };
  const i = makeButton("board");
  i.followUp = async () => {
    throw new Error("private follow-up failure");
  };
  await h.handleInteraction(i);
  assert.equal(i.edits.length, 0, "outer handler edited public source message");
  assert.equal(s.busy, false);
  assert.equal(c.navigationByUser.get("u")?.busy ?? false, false);
});
test("deferred callback without a message ID falls back to fetching the original", async () => {
  const c = setup(),
    i = opening("board");
  let fetched = 0;
  i.deferReply = async () => {
    i.deferred = true;
    return { interaction: { responseMessageId: null }, resource: null };
  };
  i.fetchReply = async () => {
    fetched++;
    return { id: "board" };
  };
  i.editReply = async () => {
    assert.equal(c.userStates.get("u-commands").messageId, "board");
    return { id: "board" };
  };
  await c.execute(i);
  assert.equal(fetched, 1);
  assert.equal(c.userStates.get("u-commands").messageId, "board");
});
test("AI exact windows, midnight priority, active release idempotence", () => {
  let now = Date.UTC(2026, 10, 27, 23, 59, 30);
  const a = new AiAdmission(6, () => now);
  const acquire = (u: string) => {
    const r = a.tryAcquire(u, "g");
    assert.ok(r.ok);
    return r.release;
  };
  const reason = (u: string) => {
    const r = a.tryAcquire(u, "g");
    assert.ok(!r.ok);
    return r.reason;
  };
  const long = acquire("long");
  for (let i = 0; i < 5; i++) {
    const release = acquire("u");
    release();
    release();
    now += 5000;
  }
  assert.equal(reason("u"), "daily_limit");
  now += 5000;
  assert.equal(reason("u"), "user_minute_limit");
  assert.equal(reason("long"), "user_inflight");
  now += 29999;
  assert.equal(reason("u"), "user_minute_limit");
  now++;
  const release = acquire("u");
  release();
  assert.equal(reason("long"), "user_inflight");
  long();
  long();
  const again = acquire("long");
  again();
});
