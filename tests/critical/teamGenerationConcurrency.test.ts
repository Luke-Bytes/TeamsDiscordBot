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

function makePlayer(id: string, ign: string, elo: number) {
  return { discordSnowflake: id, ignUsed: ign, elo } as any;
}

function snowflake(n: number) {
  return `20000000000000000${String(n).padStart(2, "0")}`;
}

function setupGuild(ids: string[], organiserIds: string[]) {
  const config = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;
  organiserIds.forEach((id) => {
    const member = new FakeGuildMember(id);
    member.roles.add(config.roles.organiserRole);
    try {
      Object.setPrototypeOf(
        member.roles,
        (GuildMemberRoleManager as any).prototype
      );
    } catch {
      // ignore
    }
    guild.addMember(member as any);
  });

  ids.forEach((id) => guild.addMember(new FakeGuildMember(id) as any));
  return guild;
}

function stubChannels() {
  (Channels as any).teamPicking = {
    id: "teamPickingChannel",
    isSendable: () => true,
    send: async (_payload: any) => ({
      edit: async (_next: any) => {},
      delete: async () => {},
      embeds: [],
    }),
    messages: { fetch: async () => ({ find: () => undefined }) },
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
  assert(ids.join(",") === expected.join(","), "Roster matches expected");
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
  return i;
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

// 1) Interaction timing: simulate slow cleanup before defer

test("Team generate handles slow cleanup without duplicate teams", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6].map((n) => snowflake(10 + n));
    const guild = setupGuild(ids, ["ORG1"]);
    stubChannels();

    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    try {
      (DiscordUtil as any).getGuildMember = () =>
        guild.members.cache.get("ORG1");
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {
        await new Promise((r) => setTimeout(r, 50));
      };

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx)
      );

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, "ORG1", "random");
      await runConfirm(teamCmd, "random-team-accept", guild);

      assertNoDuplicates(game);
      assertRosterMatches(game, ids);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
    }
  }));

// 2) Concurrent organisers: generate + cancel + generate

test("Concurrent organiser cancel and regenerate keeps state consistent", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => snowflake(20 + n));
    const guild = setupGuild(ids, ["ORG1", "ORG2"]);
    stubChannels();

    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    try {
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = (interaction: any) =>
        guild.members.cache.get(interaction.user?.id ?? "ORG1");

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx)
      );

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, "ORG1", "random");

      const cancel = createChatInputInteraction("ORG2", {
        guild,
        member: guild.members.cache.get("ORG2"),
        subcommand: "cancel",
      }) as any;
      cancel.inGuild = () => true;
      cancel.guild = guild;
      await teamCmd.execute(cancel);

      await runGenerate(teamCmd, guild, "ORG1", "elo");
      await runConfirm(teamCmd, "random-team-accept", guild);

      assertNoDuplicates(game);
      assertRosterMatches(game, ids);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
    }
  }));

// 3) Registration during active session

test("Register/unregister during active session does not create duplicates", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => snowflake(30 + n));
    const guild = setupGuild(ids, ["ORG3"]);
    stubChannels();

    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    try {
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () =>
        guild.members.cache.get("ORG3");

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx)
      );

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, "ORG3", "random");

      // Simulate a user unregistering mid-session
      const unregisterId = ids[7];
      await game.removePlayerByDiscordId(unregisterId as any);

      await runConfirm(teamCmd, "random-team-accept", guild);

      const expected = ids.filter((id) => id !== unregisterId);
      assertNoDuplicates(game);
      assertRosterMatches(game, expected);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
    }
  }));

// 4) Mass register after reset then generate

test("Mass register after reset then generate has clean roles", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6].map((n) => snowflake(40 + n));
    const guild = setupGuild(ids, ["ORG4"]);
    stubChannels();

    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    try {
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () =>
        guild.members.cache.get("ORG4");

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx)
      );

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, "ORG4", "random");
      await runConfirm(teamCmd, "random-team-accept", guild);

      const reset = createChatInputInteraction("ORG4", {
        guild,
        member: guild.members.cache.get("ORG4"),
        subcommand: "reset",
      }) as any;
      reset.inGuild = () => true;
      reset.guild = guild;
      reset.deferReply = async () => ({}) as any;
      reset.editReply = async (_payload: any) => ({}) as any;
      await teamCmd.execute(reset);

      // Emulate mass register by repopulating undecided
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx)
      );

      await runGenerate(teamCmd, guild, "ORG4", "balance");
      await runConfirm(teamCmd, "random-team-accept", guild);

      assertNoDuplicates(game);
      assertRosterMatches(game, ids);
      assertRolesMatchTeams(guild, game);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
    }
  }));

// 5) Fast toggling generate methods (random -> cancel -> balance -> cancel -> elo)

test("Rapid generate/cancel across methods keeps roles consistent", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => snowflake(50 + n));
    const guild = setupGuild(ids, ["ORG5"]);
    stubChannels();

    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    try {
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () =>
        guild.members.cache.get("ORG5");

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx)
      );

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, "ORG5", "random");
      await runConfirm(teamCmd, "random-team-generate-cancel", guild);
      assert(!teamCmd.isTeamPickingSessionActive(), "Random cancelled");

      await runGenerate(teamCmd, guild, "ORG5", "balance");
      await runConfirm(teamCmd, "random-team-generate-cancel", guild);
      assert(!teamCmd.isTeamPickingSessionActive(), "Balance cancelled");

      await runGenerate(teamCmd, guild, "ORG5", "elo");
      await runConfirm(teamCmd, "random-team-accept", guild);

      assertNoDuplicates(game);
      assertRosterMatches(game, ids);
      assertRolesMatchTeams(guild, game);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
    }
  }));
