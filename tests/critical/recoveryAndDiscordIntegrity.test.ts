import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { GameInstance } from "../../src/database/GameInstance";
import { MatchRecoveryGate } from "../../src/logic/MatchRecoveryGate";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { assignTeamVCAfterPicking } from "../../src/commands/GameCommand";
import { ConfigManager } from "../../src/ConfigManager";
import { FakeGuild, FakeGuildMember, FakeVoiceChannel } from "../framework/mocks";
import { TempVoiceChannelManager } from "../../src/logic/TempVoiceChannelManager";
import { prismaClient } from "../../src/database/prismaClient";
import { cleanUpAfterGame } from "../../src/logic/GameEndCleanUp";
import { Channels } from "../../src/Channels";
import { LeaderBoardFeed } from "../../src/logic/gameFeed/LeaderBoardFeed";
import { gameFeed } from "../../src/logic/gameFeed/GameFeed";

test("pending committed cleanup blocks new match announcement until explicitly inspected", async () => {
  try {
    await MatchRecoveryGate.inspectPending(async () => ["match-pending"]);
    assert(MatchRecoveryGate.getBlockReason()?.includes("match-pending") === true,
      "Durable pending match ID must block startup");
    const game = GameInstance.getInstance();
    game.reset();
    let refused = false;
    try { game.beginConfirmedAnnouncement(); } catch { refused = true; }
    assert(refused, "Application logic must also refuse a new announcement");
  } finally {
    await MatchRecoveryGate.inspectPending(async () => []);
  }
});

test("startup cleanup inspection is fail-closed when DB status is unknown", async () => {
  try {
    await MatchRecoveryGate.inspectPending(async () => { throw new Error("database unavailable"); });
    assert(MatchRecoveryGate.getBlockReason()?.includes("Cannot verify") === true,
      "No successful read cannot be mistaken for no pending match");
  } finally {
    await MatchRecoveryGate.inspectPending(async () => []);
  }
});

test("successfully inspected empty pending queue permits next lifecycle", async () => {
  await MatchRecoveryGate.inspectPending(async () => []);
  assert(MatchRecoveryGate.getBlockReason() === null, "Empty result releases gate");
  const game = GameInstance.getInstance();
  game.reset();
  game.beginConfirmedAnnouncement();
  assert(game.gameId === game.getLifecycleToken(), "Match has stable new claim ID");
  game.reset();
});

test("game voice startup reports partial move failure rather than claiming success", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const players = [
    { discordSnowflake: "red", ignUsed: "Red" },
    { discordSnowflake: "blue", ignUsed: "Blue" },
  ];
  game.teams.RED = [players[0] as any];
  game.teams.BLUE = [players[1] as any];
  const guild = new FakeGuild() as any;
  const cache = new Map<string, any>();
  cache.set("red", new FakeGuildMember("red"));
  cache.set("blue", new FakeGuildMember("blue"));
  const original = DiscordUtil.moveToVC;
  const moved: string[] = [];
  (DiscordUtil as any).moveToVC = async (_guild: any, _channel: any, _role: any, id: string) => {
    if (id === "blue") throw Object.assign(new Error("Discord timeout after possible move"), { code: 504 });
    moved.push(id);
  };
  try {
    let error = "";
    try { await assignTeamVCAfterPicking(guild, cache); }
    catch (caught) { error = String(caught); }
    assert(error.includes("incomplete"), "Partial/unknown voice status must fail the start");
    assert(moved.includes("red"), "Fake demonstrates some other voice operations succeeded");
  } finally {
    (DiscordUtil as any).moveToVC = original;
    game.reset();
  }
});

test("role and voice cleanup report partial Discord failures without dropping remaining attempts", async () => {
  const guild = new FakeGuild() as any;
  const roleId = "team-role";
  let succeeded = 0;
  const okMember = { id: "ok", roles: { remove: async () => { succeeded++; } } };
  const failMember = {
    id: "failed",
    roles: { remove: async () => { throw Object.assign(new Error("No permissions"), { code: 50013 }); } },
  };
  guild.roles.cache = new Map([[
    roleId,
    { id: roleId, name: "Team", members: new Map([["ok", okMember], ["failed", failMember]]) },
  ]]);
  let failed = false;
  try { await DiscordUtil.batchRemoveRoleFromMembers(guild, roleId, 5, 0); }
  catch { failed = true; }
  assert(failed && succeeded === 1, "Partial role cleanup must not appear successful");

  const source = new FakeVoiceChannel("source", "Source") as any;
  const target = new FakeVoiceChannel("target", "Target") as any;
  let moved = 0;
  source.members = new Map([
    ["ok", { voice: { setChannel: async () => { moved++; } } }],
    ["failed", { voice: { setChannel: async () => { throw new Error("unknown status"); } } }],
  ]);
  guild.addChannel(source);
  guild.addChannel(target);
  failed = false;
  try { await DiscordUtil.batchMoveMembersToChannel(guild, "source", "target", 5, 0); }
  catch { failed = true; }
  assert(failed && moved === 1, "Partial voice cleanup must fail while attempting the entire batch");
});

test("temp voice channel deletion failure preserves durable ownership record", async () => {
  const delegate = (prismaClient as any).temporaryVoiceChannel;
  const original = {
    findFirst: delegate.findFirst,
    delete: delegate.delete,
  };
  const guild = new FakeGuild() as any;
  const channel = new FakeVoiceChannel("temp", "Temp") as any;
  channel.delete = async () => { throw Object.assign(new Error("Forbidden"), { code: 50013 }); };
  guild.addChannel(channel);
  const record = {
    id: "record", guildId: guild.id, channelId: "temp", ownerId: "owner",
    categoryId: "category", name: "Temp", createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000), locked: false,
    invitedUserIds: [],
  };
  let retained = true;
  delegate.findFirst = async () => retained ? record : null;
  delegate.delete = async () => { retained = false; return record; };
  try {
    const manager = new TempVoiceChannelManager();
    let failed = false;
    try { await manager.deleteForOwner(guild, "owner"); } catch { failed = true; }
    assert(failed && retained, "No DB deletion after uncertain Discord delete");
    channel.delete = async () => {};
    await manager.deleteForOwner(guild, "owner");
    assert(!retained, "Record can be cleaned after confirmed deletion");
    const repeated = await manager.deleteForOwner(guild, "owner");
    assert(repeated === null, "Repeated confirmed cleanup is harmless");
  } finally {
    delegate.findFirst = original.findFirst;
    delegate.delete = original.delete;
  }
});

test("postcommit shutdown role failure retains the result and leaves cleanup uncheckpointed", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  game.isFinished = true;
  game.gameWinner = "RED";
  game.isRestarting = true;
  const token = game.getLifecycleToken();
  const guild = new FakeGuild() as any;
  guild.roles.cache = new Map([[
    ConfigManager.getConfig().roles.captainRole,
    { members: new Map() },
  ]]);
  const original = {
    mvp: game.countMVPVotes,
    save: (prismaClient as any).game.saveGameFromInstance,
    mark: (prismaClient as any).game.updateMany,
    role: DiscordUtil.batchRemoveRoleFromMembers,
    voice: DiscordUtil.batchMoveMembersToChannel,
    send: DiscordUtil.sendMessage,
    clean: DiscordUtil.cleanUpAllChannelMessages,
    feed: (Channels as any).gameFeed,
    removeFeed: gameFeed.removeAllFeedMessages,
    leaderboard: LeaderBoardFeed.prototype.generateEmbed,
  };
  let committed = false;
  let markerAttempted = false;
  (game as any).countMVPVotes = async () => {};
  (prismaClient as any).game.saveGameFromInstance = async () => { committed = true; };
  (prismaClient as any).game.updateMany = async () => {
    markerAttempted = true; return { count: 1 };
  };
  (DiscordUtil as any).batchRemoveRoleFromMembers = async () => {
    throw Object.assign(new Error("Discord role update forbidden"), { code: 50013 });
  };
  (DiscordUtil as any).batchMoveMembersToChannel = async () => {};
  (DiscordUtil as any).sendMessage = async () => {};
  (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
  (Channels as any).gameFeed = { send: async () => {} };
  (gameFeed as any).removeAllFeedMessages = () => {};
  LeaderBoardFeed.prototype.generateEmbed = async () => ({}) as any;
  try {
    let failed = false;
    try { await cleanUpAfterGame(guild); } catch (error) {
      failed = String(error).includes("operator reconciliation");
    }
    assert(failed && committed, "Match must commit first, then report incomplete cleanup");
    assert(!markerAttempted, "Unfinished external cleanup must remain pending on disk");
    assert(game.getLifecycleToken() === token && game.isFinished &&
      game.gameWinner === "RED", "No reset or lost result after cleanup failure");
  } finally {
    (game as any).countMVPVotes = original.mvp;
    (prismaClient as any).game.saveGameFromInstance = original.save;
    (prismaClient as any).game.updateMany = original.mark;
    (DiscordUtil as any).batchRemoveRoleFromMembers = original.role;
    (DiscordUtil as any).batchMoveMembersToChannel = original.voice;
    (DiscordUtil as any).sendMessage = original.send;
    (DiscordUtil as any).cleanUpAllChannelMessages = original.clean;
    (Channels as any).gameFeed = original.feed;
    (gameFeed as any).removeAllFeedMessages = original.removeFeed;
    LeaderBoardFeed.prototype.generateEmbed = original.leaderboard;
    game.reset();
  }
});

test("temp voice recovery does not discard channel records when guild lookup fails", async () => {
  const delegate = (prismaClient as any).temporaryVoiceChannel;
  const original = { findMany: delegate.findMany, delete: delegate.delete };
  let deleted = false;
  delegate.findMany = async () => [{
    id: "r", guildId: "unknown", channelId: "temp",
    ownerId: "owner", categoryId: "category", name: "Temp",
    createdAt: new Date(), expiresAt: new Date(), locked: false,
    invitedUserIds: [],
  }];
  delegate.delete = async () => { deleted = true; };
  try {
    const client = {
      guilds: { cache: new Map(), fetch: async () => { throw new Error("Discord unavailable"); } },
    };
    await new TempVoiceChannelManager().recoverActiveChannels(client as any);
    assert(!deleted, "Unknown guild state must not be treated as confirmed deletion");
  } finally {
    delegate.findMany = original.findMany;
    delegate.delete = original.delete;
  }
});
