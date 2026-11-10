import { EventEmitter } from "events";
import { EmbedBuilder } from "discord.js";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { createChatInputInteraction, FakeGuild, FakeVoiceChannel } from "../framework/mocks";
import SeasonRecapCommand from "../../src/commands/SeasonRecapCommand";
import LeaderboardsCommand from "../../src/commands/LeaderboardsCommand";
import GameCommand from "../../src/commands/GameCommand";
import AnnouncementCommand from "../../src/commands/AnnouncementCommand";
import { GameInstance } from "../../src/database/GameInstance";
import { Channels } from "../../src/Channels";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { prismaClient } from "../../src/database/prismaClient";
import { TempVoiceChannelManager } from "../../src/logic/TempVoiceChannelManager";
import { gameFeed } from "../../src/logic/gameFeed/GameFeed";
import { MinerushVoteManager } from "../../src/logic/MinerushVoteManager";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function recapButton(customId: string, messageId: string, userId = "owner") {
  const replies: any[] = [];
  return {
    customId,
    message: { id: messageId },
    user: { id: userId },
    replies,
    update: async (payload: any) => { replies.push(payload); },
    editReply: async (payload: any) => { replies.push(payload); },
    reply: async (payload: any) => { replies.push(payload); },
  } as any;
}

test("season recap consumes the exact message before concurrent publication and rejects stale users", async () => {
  const command = new SeasonRecapCommand() as any;
  const recap = { seasonNumber: 8, blocks: ["one", "two"] };
  const pending = { messageId: "recap-1", userId: "owner", recap };
  command.pendingByMessage.set(pending.messageId, pending);
  command.pendingByUser.set(pending.userId, pending);

  const previous = Channels.announcements;
  const gate = deferred();
  const sends: string[] = [];
  (Channels as any).announcements = {
    send: async (block: string) => {
      sends.push(block);
      if (block === "one") await gate.promise;
    },
  };
  try {
    const intruder = recapButton("season-recap-publish", "recap-1", "intruder");
    await command.handleButtonPress(intruder);
    assert(sends.length === 0 && /only the organiser/i.test(intruder.replies[0].content), "Other users cannot publish");

    const first = recapButton("season-recap-publish", "recap-1");
    const second = recapButton("season-recap-publish", "recap-1");
    const firstRun = command.handleButtonPress(first);
    await Promise.resolve();
    await command.handleButtonPress(second);
    assertEqual(sends.length, 1, "Second click cannot begin publishing");
    assert(/expired/i.test(second.replies[0].content), "Repeated confirmation is rejected");
    const wrongMessage = recapButton("season-recap-publish", "other-message");
    await command.handleButtonPress(wrongMessage);
    assert(/expired/i.test(wrongMessage.replies[0].content), "A different message cannot confirm");
    gate.resolve();
    await firstRun;
    assertEqual(sends.join(","), "one,two", "Only one ordered recap is published");
  } finally {
    (Channels as any).announcements = previous;
  }
});

test("partially failed recap cannot be retried from the same confirmation; cancellation stays safe", async () => {
  const command = new SeasonRecapCommand() as any;
  const pending = { messageId: "recap-partial", userId: "owner", recap: { seasonNumber: 9, blocks: ["ok", "fail", "after"] } };
  command.pendingByMessage.set(pending.messageId, pending);
  command.pendingByUser.set(pending.userId, pending);
  const previous = Channels.announcements;
  let sends = 0;
  (Channels as any).announcements = {
    send: async () => { sends++; if (sends === 2) throw new Error("Discord send uncertain"); },
  };
  try {
    const button = recapButton("season-recap-publish", pending.messageId);
    await command.handleButtonPress(button);
    assert(/check announcements/i.test(button.replies.at(-1).content), "Partial failure requires review");
    await command.handleButtonPress(recapButton("season-recap-publish", pending.messageId));
    assertEqual(sends, 2, "Uncertain delivery is never automatically replayed");

    const cancelPending = { ...pending, messageId: "recap-cancel" };
    command.pendingByMessage.set(cancelPending.messageId, cancelPending);
    command.pendingByUser.set(cancelPending.userId, cancelPending);
    const cancel = recapButton("season-recap-cancel", cancelPending.messageId);
    await command.handleButtonPress(cancel);
    assert(/cancelled/i.test(cancel.replies[0].content), "Cancellation still works");
    assertEqual(sends, 2, "Cancellation sends no recap blocks");
  } finally {
    (Channels as any).announcements = previous;
  }
});

test("temporary voice recovery promptly locks overdue active channels once", async () => {
  const guild = new FakeGuild();
  const channel = guild.addChannel(new FakeVoiceChannel("vc-overdue", "Overdue"));
  const record: any = {
    guildId: guild.id, channelId: channel.id, ownerId: "owner", categoryId: "category",
    name: "Overdue", createdAt: new Date(Date.now() - 60000),
    expiresAt: new Date(Date.now() + 60000),
    autoLockAt: new Date(Date.now() - 1000), locked: false, invitedUserIds: [],
  };
  const oldDelegate = (prismaClient as any).temporaryVoiceChannel;
  let updates = 0;
  (prismaClient as any).temporaryVoiceChannel = {
    findMany: async () => [record],
    findFirst: async () => record,
    update: async ({ data }: any) => { updates++; Object.assign(record, data); return record; },
    delete: async () => { throw new Error("Should not delete active channel"); },
  };
  const client: any = { guilds: { cache: { get: () => guild } } };
  try {
    const manager = new TempVoiceChannelManager();
    await manager.recoverActiveChannels(client);
    await manager.recoverActiveChannels(client);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEqual(updates, 1, "Overdue lock should apply exactly once");
    assert(record.locked, "Record is persisted as locked");
    assertEqual(channel.permissionOverwrites.cache.get(guild.id)?.Connect, false, "Connect permission is denied");
  } finally {
    (prismaClient as any).temporaryVoiceChannel = oldDelegate;
  }
});

test("game feed skips overlapping ticks, preserves initial order, and recovers from rejection", async () => {
  const previousInterval = global.setInterval;
  const previousClear = global.clearInterval;
  let tick: (() => void) | undefined;
  (global as any).setInterval = (callback: () => void, delay: number) => {
    assertEqual(delay, 20000, "Cadence stays at 20 seconds");
    tick = callback;
    return 17 as any;
  };
  (global as any).clearInterval = () => {};
  const first = deferred();
  const order: string[] = [];
  let runs = 0;
  let rejectNext = false;
  const channel: any = {
    id: "feed-overlap",
    messages: { fetch: async () => ({ edit: async () => { order.push("edit"); } }) },
    send: async ({ embeds }: any) => {
      order.push(embeds[0].data.title);
      return { id: `msg-${order.length}`, delete: async () => {} };
    },
  };
  try {
    gameFeed.addFeedMessage(channel, "first", async () => {
      runs++;
      if (runs === 1) await first.promise;
      if (rejectNext) { rejectNext = false; throw new Error("temporary feed failure"); }
      return new EmbedBuilder().setTitle("first");
    });
    gameFeed.addFeedMessage(channel, "second", async () => new EmbedBuilder().setTitle("second"));
    const startup = gameFeed.startFeed(channel);
    tick!();
    assertEqual(runs, 1, "Overlapping interval is skipped");
    first.resolve();
    await startup;
    assertEqual(order.join(","), "first,second", "Initial feed messages retain order");
    rejectNext = true;
    tick!();
    await new Promise((resolve) => setImmediate(resolve));
    tick!();
    await new Promise((resolve) => setImmediate(resolve));
    assertEqual(runs, 3, "Subsequent tick runs after a failed update");
  } finally {
    gameFeed.stopFeed(channel);
    (global as any).setInterval = previousInterval;
    (global as any).clearInterval = previousClear;
  }
});

test("stopping a game feed while an embed is pending prevents stale publication", async () => {
  const previousInterval = global.setInterval;
  const previousClear = global.clearInterval;
  (global as any).setInterval = () => 22 as any;
  (global as any).clearInterval = () => {};
  const gate = deferred();
  let sends = 0;
  const channel: any = { id: "feed-stopped", send: async () => { sends++; return { id: "unexpected" }; } };
  try {
    gameFeed.addFeedMessage(channel, "stale", async () => {
      await gate.promise;
      return new EmbedBuilder().setTitle("stale");
    });
    const startup = gameFeed.startFeed(channel);
    gameFeed.stopFeed(channel);
    gate.resolve();
    await startup;
    assertEqual(sends, 0, "Stopped feed cannot create a message from stale async work");
  } finally {
    gameFeed.stopFeed(channel);
    (global as any).setInterval = previousInterval;
    (global as any).clearInterval = previousClear;
  }
});

test("old leaderboard cleanup deletes only its captured message ID", async () => {
  const command = new LeaderboardsCommand() as any;
  command.generateLeaderboardEmbed = async () => ({ embed: new EmbedBuilder(), totalPages: 1 });
  const oldReply = DiscordUtil.replyWithMessage;
  const oldBotChannel = Channels.botCommands;
  const oldTimeout = global.setTimeout;
  const callbacks: Array<() => Promise<void>> = [];
  const fetched: string[] = [];
  const deleted: string[] = [];
  let replyNumber = 0;
  (DiscordUtil as any).replyWithMessage = async () => ({ id: `leader-${++replyNumber}` });
  (Channels as any).botCommands = { id: "bot-commands" };
  (global as any).setTimeout = (callback: () => Promise<void>) => {
    callbacks.push(callback);
    return 1 as any;
  };
  const channel: any = {
    messages: { fetch: async (id: string) => {
      fetched.push(id);
      return { delete: async () => { deleted.push(id); } };
    } },
  };
  try {
    const options = { channelId: "general", channel };
    await command.execute(createChatInputInteraction("reader", options));
    await command.execute(createChatInputInteraction("reader", options));
    await callbacks[0]();
    assertEqual(fetched.join(","), "leader-1", "Old timer fetches old message");
    assertEqual(deleted.join(","), "leader-1", "New leaderboard is untouched");
    await callbacks[1]();
    assertEqual(deleted.join(","), "leader-1,leader-2", "New timer targets only new leaderboard");
    channel.messages.fetch = async () => null;
    await callbacks[0](); // Already deleted must be harmless.
  } finally {
    (DiscordUtil as any).replyWithMessage = oldReply;
    (Channels as any).botCommands = oldBotChannel;
    (global as any).setTimeout = oldTimeout;
  }
});

test("game end rejects finalized teams when the game was never started", async () => {
  const game = GameInstance.getInstance();
  const oldAuth = PermissionsUtil.isUserAuthorised;
  game.reset();
  game.announced = true;
  game.teamsDecidedBy = "RANDOMISED";
  game.teams.RED.push({ discordSnowflake: "red" } as any);
  game.teams.BLUE.push({ discordSnowflake: "blue" } as any);
  (PermissionsUtil as any).isUserAuthorised = async () => true;
  try {
    const interaction = createChatInputInteraction("organiser", { subcommand: "end", guild: new FakeGuild() as any });
    await new GameCommand().execute(interaction);
    assert(/has not started/i.test(interaction.replies.at(-1)?.payload?.content), "Organiser gets a clear start guard");
    assert(!game.isFinished && !game.endTime, "No end-side effects occur");

    game.tryBeginGameStart();
    const stillStarting = createChatInputInteraction("organiser", { subcommand: "end", guild: new FakeGuild() as any });
    await new GameCommand().execute(stillStarting);
    assert(/has not started/i.test(stillStarting.replies.at(-1)?.payload?.content), "Starting is not yet started");
  } finally {
    (PermissionsUtil as any).isUserAuthorised = oldAuth;
    game.reset();
  }
});

test("minerush vote never opens after deadline and finalizes once if deadline passes during send", async () => {
  const game = GameInstance.getInstance();
  const oldChannel = Channels.announcements;
  const oldNow = Date.now;
  const base = oldNow();
  let fakeNow = base;
  Date.now = () => fakeNow;
  let sent = 0;
  let ended = 0;
  (Channels as any).announcements = {
    isSendable: () => true,
    send: async () => {
      sent++;
      fakeNow += 2500;
      return {
        poll: { end: async () => { ended++; throw new Error("poll already removed"); },
          answers: new Map([["yes", { text: "Yes", voteCount: 3 }], ["no", { text: "No", voteCount: 1 }]]) },
        delete: async () => {},
      };
    },
  };
  try {
    game.reset();
    game.startTime = new Date(base + 4 * 60 * 1000);
    await new MinerushVoteManager().startMinerushVote();
    assertEqual(sent, 0, "Past deadline cannot publish a 48-hour poll");
    game.startTime = new Date(base + 5 * 60 * 1000 + 500);
    await new MinerushVoteManager().startMinerushVote();
    assertEqual(sent, 0, "Near-expired window cannot leave a long-lived poll");

    game.startTime = new Date(base + 5 * 60 * 1000 + 2000);
    const manager = new MinerushVoteManager();
    let outcomes = 0;
    manager.on("pollEnd", () => { outcomes++; });
    await manager.startMinerushVote();
    await Promise.all([manager.finalizeVotes(), manager.stopVote()]);
    assertEqual(sent, 1, "One valid poll was sent");
    assertEqual(ended, 1, "Poll close is claimed before concurrent completion");
    assertEqual(outcomes, 1, "Result is emitted exactly once even if Discord end fails");
  } finally {
    game.reset();
    Date.now = oldNow;
    (Channels as any).announcements = oldChannel;
  }
});

test("stale announcement message collectors cannot edit a reset game", async () => {
  const game = GameInstance.getInstance();
  const command = new AnnouncementCommand() as any;
  for (const [button, content] of [
    ["handleEditTime", "tomorrow at 7pm"],
    ["handleEditMap", "DUELSTAL"],
    ["handleEditBannedClasses", "SCOUT"],
  ]) {
    game.reset();
    game.startTime = new Date("2030-01-01T18:00:00Z");
    game.settings.map = "CANYON1V1" as any;
    game.settings.organiserBannedClasses = ["ACROBAT"] as any;
    const collector = new EventEmitter() as any;
    collector.stop = () => { collector.emit("end", [], "user"); };
    const replies: string[] = [];
    const interaction: any = {
      user: { id: "organiser" },
      guild: new FakeGuild(),
      channel: { createMessageCollector: () => collector },
      editReply: async () => {},
      followUp: async (text: string) => { replies.push(text); },
    };
    await command[button](interaction);
    game.reset();
    game.announced = true;
    game.startTime = new Date("2031-02-01T10:00:00Z");
    game.settings.map = "CANYON1V1" as any;
    game.settings.organiserBannedClasses = ["ACROBAT"] as any;
    collector.emit("collect", { author: { id: "organiser" }, content });
    await new Promise((resolve) => setImmediate(resolve));
    assert(replies.some((message) => /expired/i.test(message)), `${button} rejects a stale collector`);
    assertEqual(game.startTime.toISOString(), "2031-02-01T10:00:00.000Z", "New game time remains unchanged");
    assertEqual(game.settings.map, "CANYON1V1" as any, "New game map remains unchanged");
    assertEqual(game.settings.organiserBannedClasses.join(","), "ACROBAT", "New game bans remain unchanged");
  }
  // Current-session collectors still accept valid input.
  game.reset();
  const collector = new EventEmitter() as any;
  collector.stop = () => {};
  await command.handleEditMap({
    user: { id: "organiser" }, guild: new FakeGuild(),
    channel: { createMessageCollector: () => collector },
    editReply: async () => {}, followUp: async () => {},
  });
  collector.emit("collect", { author: { id: "organiser" }, content: "DUELSTAL" });
  await new Promise((resolve) => setImmediate(resolve));
  assertEqual(game.settings.map, "DUELSTAL" as any, "Current collector still updates the map");
  game.reset();
});
