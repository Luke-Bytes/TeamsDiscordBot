import { test } from "../framework/test";
import { assert } from "../framework/assert";
import TeamCommand from "../../src/commands/TeamCommand";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ConfigManager } from "../../src/ConfigManager";
import { Channels } from "../../src/Channels";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { withImmediateTimers } from "../framework/timers";
import { GuildMemberRoleManager } from "discord.js";

function makePlayer(id: string, ign: string, elo: number, captain = false) {
  return { discordSnowflake: id, ignUsed: ign, elo, captain } as any;
}

function snowflake(n: number) {
  return `10000000000000000${String(n).padStart(2, "0")}`;
}

function setupGuildWithMembers(ids: string[], organiserId: string) {
  const config = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;
  const organiser = new FakeGuildMember(organiserId);
  organiser.roles.add(config.roles.organiserRole);
  try {
    Object.setPrototypeOf(
      organiser.roles,
      (GuildMemberRoleManager as any).prototype
    );
  } catch {
    // ignore
  }
  guild.addMember(organiser as any);

  ids.forEach((id) => guild.addMember(new FakeGuildMember(id) as any));
  return { guild, organiser };
}

function stubTeamPickingChannel() {
  (Channels as any).teamPicking = {
    id: "teamPickingChannel",
    isSendable: () => true,
    send: async (_payload: any) => ({
      edit: async (_next: any) => {},
      delete: async () => {},
      embeds: [],
    }),
    messages: {
      fetch: async () => ({
        find: () => undefined,
      }),
    },
  } as any;
}

function stubAnnouncementChannel() {
  (Channels as any).announcements = {
    isSendable: () => true,
    send: async (_payload: any) => ({
      edit: async (_next: any) => {},
      delete: async () => {},
      embeds: [],
    }),
  } as any;
  (Channels as any).registration = {
    isTextBased: () => true,
    send: async () => ({}),
  } as any;
  (Channels as any).gameFeed = {
    id: ConfigManager.getConfig().channels.gameFeed,
    isSendable: () => true,
    send: async () => ({}),
  } as any;
}

function assertNoDuplicates(game: any) {
  const all = [...game.teams.RED, ...game.teams.BLUE, ...game.teams.UNDECIDED];
  const ids = all.map((p: any) => p.discordSnowflake);
  const unique = new Set(ids);
  assert(ids.length === unique.size, "No duplicate players across teams");
}

function assertRosterMatches(game: any, expectedIds: string[]) {
  const all = [...game.teams.RED, ...game.teams.BLUE, ...game.teams.UNDECIDED];
  const ids = all.map((p: any) => p.discordSnowflake).sort();
  const expected = [...expectedIds].sort();
  assert(
    ids.join(",") === expected.join(","),
    "Roster matches registered players"
  );
}

function assertRolesMatchTeams(guild: any, game: any) {
  const config = ConfigManager.getConfig();
  for (const p of game.teams.RED) {
    const m = guild.members.cache.get(p.discordSnowflake);
    assert(
      m.roles.cache.has(config.roles.redTeamRole),
      "Red team role assigned"
    );
    assert(
      !m.roles.cache.has(config.roles.blueTeamRole),
      "Blue role not present for red"
    );
  }
  for (const p of game.teams.BLUE) {
    const m = guild.members.cache.get(p.discordSnowflake);
    assert(
      m.roles.cache.has(config.roles.blueTeamRole),
      "Blue team role assigned"
    );
    assert(
      !m.roles.cache.has(config.roles.redTeamRole),
      "Red role not present for blue"
    );
  }
}

async function runGenerate(
  teamCmd: TeamCommand,
  guild: any,
  organiserId: string,
  method: string
) {
  const i = createChatInputInteraction(organiserId, {
    guild,
    member: guild.members.cache.get(organiserId),
    subcommand: "generate",
    strings: { method },
  }) as any;
  i.inGuild = () => true;
  i.guild = guild;
  i.deferReply = async () => {
    i.deferred = true;
    return {};
  };
  i.editReply = async (_payload: any) => ({
    edit: async () => {},
    delete: async () => {},
    embeds: [],
  });
  await teamCmd.execute(i);
}

async function runConfirm(teamCmd: TeamCommand, customId: string, guild: any) {
  const interaction: any = {
    customId,
    guild,
    update: async () => {},
    followUp: async () => {},
  };
  await teamCmd.handleButtonPress(interaction);
}

// Announcement flow not needed for these tests; game.announced is set directly.

// Edge/sad path: snake draft cancel then switch to draft

test("Start snake draft, cancel mid run, then switch to draft", () =>
  withImmediateTimers(async () => {
    const config = ConfigManager.getConfig();
    const ids = [1, 2, 3, 4, 5, 6].map(snowflake);
    const { guild, organiser } = setupGuildWithMembers(ids, "ORG");
    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    const origTeamPicking = (Channels as any).teamPicking;
    const origAnnouncements = (Channels as any).announcements;
    const origRegistration = (Channels as any).registration;
    const origGameFeed = (Channels as any).gameFeed;
    try {
      stubTeamPickingChannel();
      stubAnnouncementChannel();
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () => organiser as any;

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.RED = [makePlayer(ids[0], "RedCap", 1200, true)];
      game.teams.BLUE = [makePlayer(ids[1], "BlueCap", 1200, true)];
      game.teams.UNDECIDED = [
        makePlayer(ids[2], "A", 1000),
        makePlayer(ids[3], "B", 1000),
        makePlayer(ids[4], "C", 1000),
        makePlayer(ids[5], "D", 1000),
      ];

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, organiser.id, "snake");
      assert(teamCmd.isTeamPickingSessionActive(), "Snake session active");

      const cancel = createChatInputInteraction(organiser.id, {
        guild,
        member: guild.members.cache.get(organiser.id),
        subcommand: "cancel",
      }) as any;
      cancel.inGuild = () => true;
      cancel.guild = guild;
      await teamCmd.execute(cancel);

      assert(!teamCmd.isTeamPickingSessionActive(), "Session cancelled");

      await runGenerate(teamCmd, guild, organiser.id, "draft");
      assert(teamCmd.isTeamPickingSessionActive(), "Draft session active");

      // Roles should still only be captains at this stage.
      const redCapMember = guild.members.cache.get(ids[0]);
      assert(
        redCapMember.roles.cache.has(config.roles.redTeamRole),
        "Red captain role assigned"
      );
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
      (Channels as any).teamPicking = origTeamPicking;
      (Channels as any).announcements = origAnnouncements;
      (Channels as any).registration = origRegistration;
      (Channels as any).gameFeed = origGameFeed;
    }
  }));

// Happy path: random -> accept -> generate balance after cancel

test("Confirm random teams, then cancel and generate balance", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => snowflake(10 + n));
    const { guild, organiser } = setupGuildWithMembers(ids, "ORG2");
    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    const origTeamPicking = (Channels as any).teamPicking;
    const origAnnouncements = (Channels as any).announcements;
    const origRegistration = (Channels as any).registration;
    const origGameFeed = (Channels as any).gameFeed;
    try {
      stubTeamPickingChannel();
      stubAnnouncementChannel();
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () => organiser as any;

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${idx + 1}`, 1000 + idx * 10)
      );

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, organiser.id, "random");
      await runConfirm(teamCmd, "random-team-accept", guild);

      assertNoDuplicates(game);
      assertRosterMatches(game, ids);
      assertRolesMatchTeams(guild, game);

      // Attempt to generate again should be blocked until cancel
      const blocked = createChatInputInteraction(organiser.id, {
        guild,
        member: guild.members.cache.get(organiser.id),
        subcommand: "generate",
        strings: { method: "balance" },
      }) as any;
      blocked.inGuild = () => true;
      blocked.guild = guild;
      await teamCmd.execute(blocked);
      const blockedReply = blocked.replies.find((r: any) => r.type === "reply");
      assert(
        String(blockedReply?.payload?.content || "").includes(
          "already in process"
        ),
        "Should block new generation while session active"
      );

      // Cancel session and regenerate
      const cancelInteraction = createChatInputInteraction(organiser.id, {
        guild,
        member: guild.members.cache.get(organiser.id),
        subcommand: "cancel",
      }) as any;
      cancelInteraction.inGuild = () => true;
      cancelInteraction.guild = guild;
      await teamCmd.execute(cancelInteraction);

      await runGenerate(teamCmd, guild, organiser.id, "balance");
      await runConfirm(teamCmd, "random-team-accept", guild);

      assertNoDuplicates(game);
      assertRosterMatches(game, ids);
      assertRolesMatchTeams(guild, game);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
      (Channels as any).teamPicking = origTeamPicking;
      (Channels as any).announcements = origAnnouncements;
      (Channels as any).registration = origRegistration;
      (Channels as any).gameFeed = origGameFeed;
    }
  }));

// Edge case: cancel random preview then generate elo should reassign roles cleanly

test("Cancel random preview then generate elo assigns roles cleanly", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6].map((n) => snowflake(30 + n));
    const { guild, organiser } = setupGuildWithMembers(ids, "ORG3");
    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    const origTeamPicking = (Channels as any).teamPicking;
    const origAnnouncements = (Channels as any).announcements;
    const origRegistration = (Channels as any).registration;
    const origGameFeed = (Channels as any).gameFeed;
    try {
      stubTeamPickingChannel();
      stubAnnouncementChannel();
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () => organiser as any;

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1500 - idx * 50)
      );

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, organiser.id, "random");
      await runConfirm(teamCmd, "random-team-generate-cancel", guild);
      assert(!teamCmd.isTeamPickingSessionActive(), "Cancelled preview");

      await runGenerate(teamCmd, guild, organiser.id, "elo");
      await runConfirm(teamCmd, "random-team-accept", guild);

      assertNoDuplicates(game);
      assertRosterMatches(game, ids);
      assertRolesMatchTeams(guild, game);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
      (Channels as any).teamPicking = origTeamPicking;
      (Channels as any).announcements = origAnnouncements;
      (Channels as any).registration = origRegistration;
      (Channels as any).gameFeed = origGameFeed;
    }
  }));

// Sad path: generate draft without captains then switch to random

test("Draft generate without captains fails, random still works", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4].map((n) => snowflake(40 + n));
    const { guild, organiser } = setupGuildWithMembers(ids, "ORG4");
    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    const origTeamPicking = (Channels as any).teamPicking;
    const origAnnouncements = (Channels as any).announcements;
    const origRegistration = (Channels as any).registration;
    const origGameFeed = (Channels as any).gameFeed;
    try {
      stubTeamPickingChannel();
      stubAnnouncementChannel();
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () => organiser as any;

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx * 10)
      );

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, organiser.id, "draft");
      const reply = (teamCmd as any).teamPickingSession;
      assert(!reply, "Draft session should not start without captains");

      await runGenerate(teamCmd, guild, organiser.id, "random");
      await runConfirm(teamCmd, "random-team-accept", guild);
      assertNoDuplicates(game);
      assertRosterMatches(game, ids);
      assertRolesMatchTeams(guild, game);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
      (Channels as any).teamPicking = origTeamPicking;
      (Channels as any).announcements = origAnnouncements;
      (Channels as any).registration = origRegistration;
      (Channels as any).gameFeed = origGameFeed;
    }
  }));

// Edge case: confirm teams then reset and generate again should remove roles

test("Confirm random then reset teams and generate balance", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6].map((n) => snowflake(50 + n));
    const { guild, organiser } = setupGuildWithMembers(ids, "ORG5");
    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    const origTeamPicking = (Channels as any).teamPicking;
    const origAnnouncements = (Channels as any).announcements;
    const origRegistration = (Channels as any).registration;
    const origGameFeed = (Channels as any).gameFeed;
    try {
      stubTeamPickingChannel();
      stubAnnouncementChannel();
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () => organiser as any;

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx * 5)
      );

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, organiser.id, "random");
      await runConfirm(teamCmd, "random-team-accept", guild);

      const reset = createChatInputInteraction(organiser.id, {
        guild,
        member: guild.members.cache.get(organiser.id),
        subcommand: "reset",
      }) as any;
      reset.inGuild = () => true;
      reset.guild = guild;
      reset.deferReply = async () => ({}) as any;
      reset.editReply = async (_payload: any) => ({}) as any;
      await teamCmd.execute(reset);

      await runGenerate(teamCmd, guild, organiser.id, "balance");
      await runConfirm(teamCmd, "random-team-accept", guild);

      assertNoDuplicates(game);
      assertRosterMatches(game, ids);
      assertRolesMatchTeams(guild, game);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
      (Channels as any).teamPicking = origTeamPicking;
      (Channels as any).announcements = origAnnouncements;
      (Channels as any).registration = origRegistration;
      (Channels as any).gameFeed = origGameFeed;
    }
  }));
