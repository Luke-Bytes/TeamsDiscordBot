import { test } from "../framework/test";
import { assert } from "../framework/assert";
import TeamCommand from "../../src/commands/TeamCommand";
import CaptainCommand from "../../src/commands/CaptainCommand";
import MassRegisterCommand from "../../src/commands/MassRegisterCommand";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ConfigManager } from "../../src/ConfigManager";
import { Channels } from "../../src/Channels";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { prismaClient } from "../../src/database/prismaClient";
import { withImmediateTimers } from "../framework/timers";
import { GuildMemberRoleManager } from "discord.js";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";

function snowflake(n: number) {
  return `30000000000000000${String(n).padStart(2, "0")}`;
}

function makePlayer(id: string, ign: string, elo: number, captain = false) {
  return { discordSnowflake: id, ignUsed: ign, elo, captain } as any;
}

function setupGuild(ids: string[], organiserId: string) {
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

function assertNoTeamRoles(guild: any, ids: string[]) {
  const config = ConfigManager.getConfig();
  ids.forEach((id) => {
    const m = guild.members.cache.get(id);
    assert(!m.roles.cache.has(config.roles.redTeamRole), "Red role removed");
    assert(!m.roles.cache.has(config.roles.blueTeamRole), "Blue role removed");
  });
}

function assertRosterMatches(game: any, expectedIds: string[]) {
  const all = [...game.teams.RED, ...game.teams.BLUE, ...game.teams.UNDECIDED];
  const ids = all.map((p: any) => p.discordSnowflake).sort();
  const expected = [...expectedIds].sort();
  assert(ids.join(",") === expected.join(","), "Roster matches expected");
}

// 9) Draft auto-pick fires after cancel

test("Draft auto-pick after cancel does not mutate teams", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6].map((n) => snowflake(10 + n));
    const { guild, organiser } = setupGuild(ids, "ORG9");
    stubChannels();

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

    const session = new DraftTeamPickingSession("draft") as any;
    session.proposedTeams = {
      RED: [...game.teams.RED],
      BLUE: [...game.teams.BLUE],
      UNDECIDED: [...game.teams.UNDECIDED],
    };
    session.turn = "RED";
    session.state = "inProgress";

    await session.cancelSession();
    const before =
      session.proposedTeams.RED.length + session.proposedTeams.BLUE.length;

    await session.executeAutoPick("RED");

    const after =
      session.proposedTeams.RED.length + session.proposedTeams.BLUE.length;
    assert(before === after, "Auto-pick should not run after cancel");
  }));

// 12) Reset while preview active

test("Team reset during preview cancels session and removes roles", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6].map((n) => snowflake(20 + n));
    const { guild, organiser } = setupGuild(ids, "ORG12");
    stubChannels();

    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    try {
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () => organiser as any;

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx)
      );

      ids.forEach((id, idx) => {
        const m = guild.members.cache.get(id);
        if (idx % 2 === 0) {
          m.roles.add(ConfigManager.getConfig().roles.redTeamRole);
        } else {
          m.roles.add(ConfigManager.getConfig().roles.blueTeamRole);
        }
      });

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, organiser.id, "random");

      const reset = createChatInputInteraction(organiser.id, {
        guild,
        member: guild.members.cache.get(organiser.id),
        subcommand: "reset",
      }) as any;
      reset.inGuild = () => true;
      reset.guild = guild;
      reset.channelId = ConfigManager.getConfig().channels.teamPickingChat;
      reset.channel = { id: reset.channelId };
      reset.guild.members.fetch = async () => {
        const entries = [
          [organiser.id, guild.members.cache.get(organiser.id)],
          ...ids.map((id) => [id, guild.members.cache.get(id)]),
        ] as Array<[string, any]>;
        return new Map(entries);
      };
      reset.deferReply = async () => ({}) as any;
      reset.editReply = async (_payload: any) => ({}) as any;
      await teamCmd.execute(reset);

      assert(
        !teamCmd.isTeamPickingSessionActive(),
        "Session cancelled by reset"
      );
      assertNoTeamRoles(guild, ids);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
    }
  }));

// 13) /team reset during active session

test("Team reset during active session cleans roles", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6].map((n) => snowflake(30 + n));
    const { guild, organiser } = setupGuild(ids, "ORG13");
    stubChannels();

    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    try {
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () => organiser as any;

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx)
      );

      ids.forEach((id, idx) => {
        const m = guild.members.cache.get(id);
        if (idx % 2 === 0) {
          m.roles.add(ConfigManager.getConfig().roles.redTeamRole);
        } else {
          m.roles.add(ConfigManager.getConfig().roles.blueTeamRole);
        }
      });

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, organiser.id, "random");

      const reset = createChatInputInteraction(organiser.id, {
        guild,
        member: guild.members.cache.get(organiser.id),
        subcommand: "reset",
      }) as any;
      reset.inGuild = () => true;
      reset.guild = guild;
      reset.channelId = ConfigManager.getConfig().channels.teamPickingChat;
      reset.channel = { id: reset.channelId };
      reset.guild.members.fetch = async () => {
        const entries = [
          [organiser.id, guild.members.cache.get(organiser.id)],
          ...ids.map((id) => [id, guild.members.cache.get(id)]),
        ] as Array<[string, any]>;
        return new Map(entries);
      };
      reset.deferReply = async () => ({}) as any;
      reset.editReply = async (_payload: any) => ({}) as any;
      await teamCmd.execute(reset);

      assert(!teamCmd.isTeamPickingSessionActive(), "Session cancelled");
      assertNoTeamRoles(guild, ids);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
    }
  }));

// 14) generate while announce cancel happens

test("Team generate blocked when announcement cancelled", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4].map((n) => snowflake(40 + n));
    const { guild, organiser } = setupGuild(ids, "ORG14");
    stubChannels();

    const origGetMember = DiscordUtil.getGuildMember;
    try {
      (DiscordUtil as any).getGuildMember = () => organiser as any;
      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = false; // simulate /announce cancel

      const teamCmd = new TeamCommand();
      const i = await runGenerate(teamCmd, guild, organiser.id, "random");
      const reply = i.replies.find((r: any) => r.type === "reply");
      assert(
        String(reply?.payload?.content || "").includes(
          "has not been announced"
        ),
        "Blocked when announcement cancelled"
      );
    } finally {
      (DiscordUtil as any).getGuildMember = origGetMember;
    }
  }));

// 15) massregister during active session

test("Massregister during active session does not duplicate players", () =>
  withImmediateTimers(async () => {
    const ids = [1, 2, 3, 4, 5, 6].map((n) => snowflake(50 + n));
    const newIds = [7, 8].map((n) => snowflake(50 + n));
    const { guild, organiser } = setupGuild([...ids, ...newIds], "ORG15");
    stubChannels();

    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origGetMember = DiscordUtil.getGuildMember;
    const origFindFirst = (prismaClient as any).player.findFirst;
    try {
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).getGuildMember = () => organiser as any;

      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED = ids.map((id, idx) =>
        makePlayer(id, `IGN${id}`, 1000 + idx)
      );

      const teamCmd = new TeamCommand();
      await runGenerate(teamCmd, guild, organiser.id, "random");

      // Stub prisma to return new players for massregister
      (prismaClient as any).player.findFirst = async ({ where }: any) => {
        const ign = where?.latestIGN;
        const map: Record<string, string> = {
          NEW1: newIds[0],
          NEW2: newIds[1],
        };
        if (!map[ign]) return null;
        return { discordSnowflake: map[ign], latestIGN: ign };
      };

      const mass = new MassRegisterCommand();
      const massInteraction = createChatInputInteraction(organiser.id, {
        guild,
        member: guild.members.cache.get(organiser.id),
        subcommand: "massregister",
        strings: { playerlist: "NEW1 NEW2" },
      }) as any;
      massInteraction.inGuild = () => true;
      massInteraction.guild = guild;
      massInteraction.member = guild.members.cache.get(organiser.id);
      await mass.execute(massInteraction);

      await runConfirm(teamCmd, "random-team-accept", guild);

      assertRosterMatches(game, [...ids, ...newIds]);
    } finally {
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).getGuildMember = origGetMember;
      (prismaClient as any).player.findFirst = origFindFirst;
    }
  }));

// 16) captain randomise after teams generated

test("Captain randomise keeps teams, only changes captains", () =>
  withImmediateTimers(async () => {
    const config = ConfigManager.getConfig();
    const redIds = [1, 2, 3].map((n) => snowflake(60 + n));
    const blueIds = [4, 5, 6].map((n) => snowflake(60 + n));
    const { guild, organiser } = setupGuild([...redIds, ...blueIds], "ORG16");
    stubChannels();

    const game = CurrentGameManager.getCurrentGame();
    game.reset();
    game.announced = true;
    game.teamsDecidedBy = "RANDOMISED" as any;
    game.teams.RED = redIds.map((id, idx) =>
      makePlayer(id, `R${idx}`, 1200 + idx)
    );
    game.teams.BLUE = blueIds.map((id, idx) =>
      makePlayer(id, `B${idx}`, 1200 + idx)
    );
    game.teams.RED[0].captain = true;
    game.teams.BLUE[0].captain = true;

    // Ensure roles exist
    redIds.forEach((id) => {
      const m = guild.members.cache.get(id);
      m.roles.add(config.roles.redTeamRole);
    });
    blueIds.forEach((id) => {
      const m = guild.members.cache.get(id);
      m.roles.add(config.roles.blueTeamRole);
    });

    const teamCmd = new TeamCommand();
    const capCmd = new CaptainCommand(teamCmd);

    const i = createChatInputInteraction(organiser.id, {
      guild,
      member: guild.members.cache.get(organiser.id),
      subcommand: "randomise",
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    i.member = guild.members.cache.get(organiser.id);
    await capCmd.execute(i);

    const redSet = new Set(game.teams.RED.map((p) => p.discordSnowflake));
    const blueSet = new Set(game.teams.BLUE.map((p) => p.discordSnowflake));
    redIds.forEach((id) => assert(redSet.has(id), "Red team preserved"));
    blueIds.forEach((id) => assert(blueSet.has(id), "Blue team preserved"));

    const redCaptain = game.getCaptainOfTeam("RED");
    const blueCaptain = game.getCaptainOfTeam("BLUE");
    assert(
      !!redCaptain && redSet.has(redCaptain.discordSnowflake),
      "Red captain from red team"
    );
    assert(
      !!blueCaptain && blueSet.has(blueCaptain.discordSnowflake),
      "Blue captain from blue team"
    );
  }));
