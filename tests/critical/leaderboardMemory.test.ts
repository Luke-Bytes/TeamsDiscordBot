import { EmbedBuilder, MessageFlags } from "discord.js";
import { SeasonType } from "@prisma/client";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { createChatInputInteraction } from "../framework/mocks";
import LeaderboardsCommand from "../../src/commands/LeaderboardsCommand";
import { CommandHandler } from "../../src/commands/CommandHandler";
import { GameRecoveryCoordinator } from "../../src/logic/ActiveGameRecovery";
import { prismaClient } from "../../src/database/prismaClient";
import { SeasonService } from "../../src/database/SeasonService";
import { Channels } from "../../src/Channels";
import { AiAdmission, AI_USER_MINUTE_WINDOW_MS } from "../../src/ai/Admission";
import { InteractionGuard } from "../../src/util/InteractionGuard";
import { gameFeed } from "../../src/logic/gameFeed/GameFeed";

test("leaderboard queries at most one page and calculates the same ordinal for tied ratings", async () => {
  const db = prismaClient as any;
  const oldTransaction = db.$transaction;
  const oldSeason = db.season.findUnique;
  const oldActive = SeasonService.requireActiveSeason;
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: String(i).padStart(2, "0"), playerId: "p" + i,
    elo: i < 5 ? 1200 : 1100, wins: i % 4, losses: 2,
    winStreak: 0, loseStreak: 0, biggestWinStreak: i % 3,
    player: { latestIGN: "Player" + i, discordSnowflake: "u" + i },
  }));
  let available = rows;
  let type: SeasonType = SeasonType.RANKED;
  let calls: string[] = [];
  const season = () => ({ id: "season", number: 4, type });
  db.season.findUnique = async ({ where }: any) => where.number === 4 ? season() : null;
  SeasonService.requireActiveSeason = async () => season() as any;
  db.$transaction = async (work: any) => work({
    player: {
      findUnique: async ({ where, select }: any) => {
        calls.push("player");
        assertEqual(Object.keys(select).join(","), "id", "Only the player ID is selected");
        const found = available.find((r) => r.player.discordSnowflake === where.discordSnowflake);
        return found ? { id: found.playerId } : null;
      },
    },
    playerStats: {
      count: async ({ where }: any) => {
        assertEqual(where.seasonId, "season", "Count stays within season");
        calls.push(where.OR ? "rank" : "count");
        if (!where.OR) return available.length;
        const [{ elo: { gt } }, { elo, id: { lt } }] = where.OR;
        return available.filter((r) => r.elo > gt || (r.elo === elo && r.id < lt)).length;
      },
      findUnique: async ({ where, select }: any) => {
        calls.push("own");
        assertEqual(where.playerId_seasonId.seasonId, "season", "Personal stats use selected season");
        assertEqual(Object.keys(select).join(","), "id,elo", "Personal stats are narrow");
        return available.find((r) => r.playerId === where.playerId_seasonId.playerId) ?? null;
      },
      findMany: async ({ where, orderBy, skip, take, select }: any) => {
        calls.push("page");
        assertEqual(where.seasonId, "season", "Page stays within season");
        assertEqual(take, 10, "Only ten records are requested");
        assertEqual(Object.keys(select).join(","), "elo,wins,losses,winStreak,loseStreak,player", "Narrow page projection");
        const expected = type === SeasonType.RELAXED
          ? [{ wins: "desc" }, { biggestWinStreak: "desc" }, { id: "asc" }]
          : [{ elo: "desc" }, { id: "asc" }];
        assertEqual(JSON.stringify(orderBy), JSON.stringify(expected), "Stable ordering");
        return [...available].sort((a, b) =>
          (type === SeasonType.RELAXED
            ? b.wins - a.wins || b.biggestWinStreak - a.biggestWinStreak
            : b.elo - a.elo) || a.id.localeCompare(b.id)
        ).slice(skip, skip + take);
      },
    },
  });
  try {
    const command = new LeaderboardsCommand() as any;
    const first = await command.generateLeaderboardEmbed(0, "u12", 4);
    assertEqual(first.totalPages, 3, "Twenty-five players require three pages");
    assertEqual(first.embed.data.fields.length, 10, "Ten displayed entries");
    assert(first.embed.data.footer.text.includes("#13 | Page 1/3"), "Off-page tied user's rank is ordinal 13");
    assertEqual(calls.join(","), "count,page,player,own,rank", "Bounded off-page query count");
    calls = [];
    const second = await command.generateLeaderboardEmbed(1, "u12", 4);
    assert(second.embed.data.fields[2].name.startsWith("#13 **Player12**"), "Same rank on the user's page");
    assert(second.embed.data.footer.text.includes("#13 | Page 2/3"), "Visible personal rank agrees");
    assertEqual(calls.join(","), "count,page", "Visible user needs no separate lookup");
    const unranked = await command.generateLeaderboardEmbed(0, "unknown");
    assert(unranked.embed.data.footer.text.includes("Unranked"), "Unknown user is unranked");
    type = SeasonType.RELAXED;
    calls = [];
    const relaxed = await command.generateLeaderboardEmbed(0, "u12", 4);
    assert(relaxed.embed.data.footer.text.startsWith("Unranked activity"), "Relaxed has no personal Elo rank");
    assert(relaxed.embed.data.fields[0].name.includes("5 games"), "Relaxed uses wins and activity formatting");
    assertEqual(calls.join(","), "count,page", "No unnecessary personal lookup");
    available = rows.slice(0, 11);
    const clamped = await command.generateLeaderboardEmbed(20, "u12", 4);
    assertEqual(clamped.page, 1, "Shrinking season clamps page");
    assertEqual(clamped.embed.data.fields.length, 1, "Last page has remaining row");
    available = [];
    const empty = await command.generateLeaderboardEmbed(20, "u12", 4);
    assertEqual(empty.page, 0, "Empty page is zero based");
    assertEqual(empty.totalPages, 1, "Empty board never displays page 1/0");
    assert(empty.embed.data.footer.text.endsWith("Page 1/1"), "Empty footer valid");
    let invalid = false;
    try { await command.generateLeaderboardEmbed(0, "u12", 0); }
    catch (error) { invalid = String(error).includes("Season #0 not found"); }
    assert(invalid, "Explicit invalid season does not fall back to active season");
  } finally {
    db.$transaction = oldTransaction;
    db.season.findUnique = oldSeason;
    SeasonService.requireActiveSeason = oldActive;
  }
});

test("leaderboard sessions acknowledge promptly, isolate owners, clamp and expire safely", async () => {
  const command = new LeaderboardsCommand() as any;
  const previousChannel = Channels.botCommands;
  const previousNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  (Channels as any).botCommands = { id: "commands" };
  let generated = 0;
  let messageNumber = 0;
  let lastRequested = -1;
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const chat = (user: string) => {
    const interaction = createChatInputInteraction(user, { channelId: "commands" });
    const id = "message-" + ++messageNumber;
    (interaction as any).deferReply = async () => {
      interaction.deferred = true;
      return { interaction: { responseMessageId: id } };
    };
    (interaction as any).editReply = async (payload: any) => {
      interaction.replies.push({ payload });
      return { id };
    };
    return { interaction, id };
  };
  const button = (user: string, id: string, customId = "leaderboard_next") => {
    const i: any = {
      user: { id: user }, channelId: "commands", message: { id }, customId,
      deferred: false, replies: [], edits: [],
      deferUpdate: async () => { i.deferred = true; },
      reply: async (payload: any) => { i.replies.push(payload); },
      followUp: async (payload: any) => { i.replies.push(payload); },
      editReply: async (payload: any) => { i.edits.push(payload); },
    };
    return i;
  };
  command.generateLeaderboardEmbed = async (page: number) => {
    generated++;
    lastRequested = page;
    await gate;
    return { embed: new EmbedBuilder(), page: Math.max(0, Math.min(page, 1)), totalPages: 2 };
  };
  try {
    const owner = chat("owner");
    const opening = command.execute(owner.interaction);
    assert(owner.interaction.deferred, "Slash defers before slow queries");
    await opening;
    const old = button("owner", owner.id);
    const stranger = button("stranger", owner.id);
    await command.handleButtonPress(stranger);
    assertEqual(stranger.replies[0].flags, MessageFlags.Ephemeral, "Foreign click denied privately");
    assertEqual(command.userStates.size, 1, "Foreign click creates no session");
    assertEqual(generated, 1, "Foreign click makes no database query");

    gate = new Promise<void>((resolve) => { release = resolve; });
    const update = command.handleButtonPress(old);
    assert(old.deferred, "Button defers before slow queries");
    const repeat = button("owner", owner.id);
    await command.handleButtonPress(repeat);
    assert(repeat.replies[0].content.includes("wait"), "Repeated click while busy does not queue");
    release?.();
    await update;
    gate = undefined;
    assertEqual(command.userStates.get("owner-commands").currentPage, 1, "Successful page is stored");
    const rapid = button("owner", owner.id);
    const beforeRapid = generated;
    await command.handleButtonPress(rapid);
    assert(rapid.deferred && rapid.replies.length === 0, "Rapid duplicate click acknowledged silently");
    assertEqual(generated, beforeRapid, "Sub-500ms click starts no query");
    now += 500;
    const next = button("owner", owner.id);
    await command.handleButtonPress(next);
    assertEqual(command.userStates.get("owner-commands").currentPage, 1, "Clamp stored even after stale next press");
    assert(next.edits[0].components[0].components[1].data.disabled, "Last page next button disabled");
    now += 500;
    const prev = button("owner", owner.id, "leaderboard_prev");
    await command.handleButtonPress(prev);
    assertEqual(lastRequested, 0, "Previous starts from clamped page, not stale request");

    now += 500;
    const failed = button("owner", owner.id);
    failed.editReply = async () => { throw new Error("Discord edit unavailable"); };
    await command.handleButtonPress(failed);
    assertEqual(command.userStates.get("owner-commands").currentPage, 0, "Failed edit cannot advance stored page");
    assertEqual(failed.replies[0].flags, MessageFlags.Ephemeral, "Deferred failure is explained privately");

    // A slow first opening cannot replace the session of a newer opening.
    gate = new Promise<void>((resolve) => { release = resolve; });
    const superseded = chat("owner");
    const pendingOpening = command.execute(superseded.interaction);
    await Promise.resolve();
    const releaseOpening = release;
    gate = undefined;
    const replacement = chat("owner");
    await command.execute(replacement.interaction);
    releaseOpening?.();
    await pendingOpening;
    assertEqual(superseded.interaction.replies.at(-1)?.payload.components.length, 0, "Superseded opening has no controls");
    assertEqual(command.userStates.get("owner-commands").messageId, replacement.id, "Newest opening owns navigation");
    await command.handleButtonPress(old);
    assert(old.replies.at(-1).content.includes("expired"), "Old buttons no longer usable");
    command.removeMessageSession(owner.id);
    assertEqual(command.userStates.size, 1, "Old deletion does not remove replacement");
    now += 30 * 60_000;
    const expired = button("owner", replacement.id);
    await command.handleButtonPress(expired);
    assert(expired.replies[0].content.includes("/leaderboards"), "Expired button provides recovery guidance");
    assertEqual(command.userStates.size, 0, "Expired session removed");
    for (let i = 0; i < 1100; i++) {
      command.startSession("user-" + i);
    }
    assertEqual(command.userStates.size, 1000, "Session count is bounded");
    now += 30 * 60_000;
    command.startSession("new");
    assertEqual(command.userStates.size, 1, "New request prunes expired sessions");
  } finally {
    Date.now = previousNow;
    (Channels as any).botCommands = previousChannel;
  }
});

test("owned leaderboard buttons bypass the generic command cooldown without exempting other interactions", async () => {
  const command = new LeaderboardsCommand() as any;
  const guard = new InteractionGuard();
  const handler = Object.assign(Object.create(CommandHandler.prototype), {
    commands: [command],
    leaderboardsCommand: command,
    interactionGuard: guard,
  });
  const previousEnter = GameRecoveryCoordinator.enterOperation;
  const previousNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  GameRecoveryCoordinator.enterOperation = () => () => {};
  const session = command.startSession("owner-commands");
  session.messageId = "board";
  session.busy = false;
  command.generateLeaderboardEmbed = async (page: number) => ({
    embed: new EmbedBuilder(), page, totalPages: 20,
  });
  const button = (userId: string, messageId: string, customId = "leaderboard_next") => {
    const i: any = {
      user: { id: userId }, channelId: "commands", message: { id: messageId }, customId,
      isButton: () => true, isChatInputCommand: () => false,
      isMessageContextMenuCommand: () => false, isUserContextMenuCommand: () => false,
      isAutocomplete: () => false, isStringSelectMenu: () => false,
      isUserSelectMenu: () => false, isModalSubmit: () => false,
      isRepliable: () => true, inGuild: () => false,
      replies: [], edits: [],
      deferUpdate: async () => { i.deferred = true; },
      reply: async (payload: any) => { i.replies.push(payload); },
      editReply: async (payload: any) => { i.edits.push(payload); },
    };
    return i;
  };
  try {
    for (let i = 0; i < 10; i++) {
      const click = button("owner", "board");
      await handler.handleInteraction(click);
      assertEqual(click.edits.length, 1, "Each spaced click advances without generic cooldown");
      now += 500;
    }
    assertEqual(session.currentPage, 10, "Ten pages browsed in five seconds");
    const slash = () => createChatInputInteraction("owner", { commandName: "leaderboards" });
    for (let i = 0; i < 3; i++) assert(await guard.checkRateLimit(slash()), "Normal command quota untouched");
    assert(!(await guard.checkRateLimit(slash())), "Slash cooldown still enforced");
    const next = button("owner", "board");
    await handler.handleInteraction(next);
    assertEqual(next.edits.length, 1, "Owner can browse during unrelated command cooldown");
    const stale = button("owner", "old-board");
    await handler.handleInteraction(stale);
    assert(stale.replies[0].content.includes("too fast"), "Stale button does not bypass generic limit");
    const unknown = button("owner", "board", "leaderboard_next_extra");
    await handler.handleInteraction(unknown);
    assert(unknown.replies[0].content.includes("too fast"), "Only exact navigation IDs qualify");
    for (let i = 0; i < 4; i++) {
      const foreign = button("stranger", "board");
      await handler.handleInteraction(foreign);
      assertEqual(foreign.edits.length, 0, "Foreign clicks never navigate");
      if (i === 3) assert(foreign.replies[0].content.includes("too fast"), "Foreign spam remains rate limited");
    }
  } finally {
    Date.now = previousNow;
    GameRecoveryCoordinator.enterOperation = previousEnter;
  }
});

test("AI admission removes expired inactive user histories without resetting limits or active users", () => {
  let now = Date.UTC(2026, 10, 27, 10);
  const admission = new AiAdmission(2000, () => now);
  const state = admission as any;
  const active = admission.tryAcquire("active", "g");
  assert(active.ok, "Active user admitted");
  for (let i = 0; i < 1000; i++) {
    const result = admission.tryAcquire("user-" + i, "g");
    assert(result.ok, "One-off user admitted");
    if (result.ok) result.release();
  }
  now += AI_USER_MINUTE_WINDOW_MS - 1;
  const fresh = admission.tryAcquire("fresh", "g");
  assert(fresh.ok, "Fresh user admitted just before cleanup");
  if (fresh.ok) fresh.release();
  now++;
  const denial = admission.tryAcquire("fresh", "g");
  assert(!denial.ok && denial.reason === "user_cooldown", "Cleanup preserves active cooldown");
  assertEqual(state.lastByUser.size, 1, "Expired timestamps removed");
  assertEqual(state.recentByUser.size, 1, "Expired rolling histories removed");
  const stillActive = admission.tryAcquire("active", "g");
  assert(!stillActive.ok && stillActive.reason === "user_inflight", "Active request is not forgotten");
  assertEqual(state.used, 1002, "Daily quota unchanged by sweep");
  if (active.ok) active.release();
});

test("interaction rate state cleanup retains live escalation and drops only inactive users", async () => {
  const guard = new InteractionGuard() as any;
  const previousNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  const inactive = { lastAction: now - 130_000, recentHistory: [], cooldownUntil: 0, cooldownLevel: 1, lastViolationAt: now - 130_000 };
  try {
    for (let i = 0; i < 1000; i++) guard.rateState.set("old-" + i, inactive);
    guard.rateState.set("long-cooldown", { ...inactive, cooldownUntil: now + 1 });
    guard.rateState.set("escalation", { ...inactive, lastViolationAt: now - 120_000 });
    guard.rateState.set("history", { ...inactive, recentHistory: [{ key: "x", time: now - 15_000 }] });
    await guard.checkRateLimit(createChatInputInteraction("new"));
    assertEqual(guard.rateState.size, 4, "Only live entries and new user remain");
    assert(guard.rateState.has("long-cooldown"), "Long cooldown preserved");
    assert(guard.rateState.has("escalation"), "Exact escalation boundary preserved");
    assert(guard.rateState.has("history"), "Exact rolling history boundary preserved");
  } finally {
    Date.now = previousNow;
  }
});

test("stopped game feed no longer retains its managed channel ID", async () => {
  const channel = { id: "memory-test-channel" } as any;
  try {
    await gameFeed.startFeed(channel);
    assert((gameFeed as any).managedChannels.has(channel.id), "Started feed tracked");
    gameFeed.stopFeed(channel);
    assert(!(gameFeed as any).managedChannels.has(channel.id), "Stopped feed released");
  } finally {
    gameFeed.stopFeed(channel);
  }
});
