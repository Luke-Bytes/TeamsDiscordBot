import { test } from "../framework/test";
import { assert } from "../framework/assert";
import {
  createButtonInteraction,
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { ConfigManager } from "../../src/ConfigManager";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import RegisterCommand from "../../src/commands/RegisterCommand";
import CaptainCommand from "../../src/commands/CaptainCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import GameCommand from "../../src/commands/GameCommand";
import ClassbanCommand from "../../src/commands/ClassbanCommand";
import WinnerCommand from "../../src/commands/WinnerCommand";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { Channels } from "../../src/Channels";
import { prismaClient } from "../../src/database/prismaClient";
import { MojangAPI } from "../../src/api/MojangAPI";
import { GuildMemberRoleManager } from "discord.js";
import { Scheduler } from "../../src/util/SchedulerUtil";
import RestartCommand from "../../src/commands/RestartCommand";
import CaptainPlanDMManager from "../../src/logic/CaptainPlanDMManager";
import AnnouncementCommand from "../../src/commands/AnnouncementCommand";
import MVPCommand from "../../src/commands/MVPCommand";

function makeRoleManagerLike(obj: any) {
  try {
    Object.setPrototypeOf(obj, (GuildMemberRoleManager as any).prototype);
  } catch {
    // ignore
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function stubPrismaAndMojang() {
  const nameToUUID = new Map<string, string>();
  const idToPlayer = new Map<string, any>();

  (MojangAPI as any).usernameToUUID = async (name: string) => {
    const uuid = `uuid-${name}`;
    nameToUUID.set(name, uuid);
    return uuid;
  };
  (MojangAPI as any).uuidToUsername = async (uuid: string) => {
    for (const [name, id] of nameToUUID) if (id === uuid) return name;
    return null;
  };

  (prismaClient as any).player.findFirst = async ({ where }: any) => {
    const ident =
      where?.OR?.[0]?.discordSnowflake || where?.OR?.[1]?.latestIGN?.equals;
    for (const p of Array.from(idToPlayer.values())) {
      if (
        p.discordSnowflake === ident ||
        p.latestIGN?.toLowerCase() === String(ident).toLowerCase()
      ) {
        return p;
      }
    }
    return null;
  };
  (prismaClient as any).player.byDiscordSnowflake = async (id: string) =>
    idToPlayer.get(id) || null;
  (prismaClient as any).player.create = async ({ data }: any) => {
    const record = {
      id: `db-${data.discordSnowflake}`,
      discordSnowflake: data.discordSnowflake,
      minecraftAccounts: [],
      latestIGN: data.latestIGN ?? null,
      primaryMinecraftAccount: null,
    };
    idToPlayer.set(record.discordSnowflake, record);
    return record;
  };
  (prismaClient as any).player.update = async ({ where, data }: any) => {
    const rec =
      idToPlayer.get(where.id) ||
      Array.from(idToPlayer.values()).find((p: any) => p.id === where.id);
    if (rec) Object.assign(rec, data);
    return rec;
  };

  (prismaClient as any).playerPunishment = {
    findFirst: async () => null,
    findMany: async () => [],
    update: async () => {},
  };
  (prismaClient as any).season = {
    findUnique: async () => ({ id: "season1", number: 1 }),
  };
  (prismaClient as any).playerStats = {
    findUnique: async () => ({
      seasonId: "season1",
      wins: 0,
      losses: 0,
      elo: 1000,
      winStreak: 0,
      loseStreak: 0,
      biggestWinStreak: 0,
      biggestLosingStreak: 0,
    }),
    create: async ({ data }: any) => ({ ...data }),
    update: async ({ where, data }: any) => ({ where, ...data }),
    findMany: async () => [],
    groupBy: async () => [],
  };

  (prismaClient as any).game = (prismaClient as any).game || {};
  (prismaClient as any).game.saveGameFromInstance = async () => {};

  return { idToPlayer };
}

async function runOneGame(params: {
  gameNumber: number;
  guild: any;
  organiser: FakeGuildMember;
  players: FakeGuildMember[];
  playerNames: string[];
  pollMaps: string;
  bannedClasses: string;
  classBan: { redCaptainBan: string; blueCaptainBan: string };
}) {
  const {
    guild,
    organiser,
    players,
    playerNames,
    pollMaps,
    bannedClasses,
    classBan,
  } = params;

  const config = ConfigManager.getConfig();

  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.organiser = `TestOrganiser-${params.gameNumber}`;
  game.host = `TestHost-${params.gameNumber}`;

  // Announcements are required for the real flow. Confirming will also kick off map polling.
  const announcementCmd = new AnnouncementCommand();
  const announceInteraction: any = createChatInputInteraction(organiser.id, {
    guild,
    member: organiser as any,
    subcommand: "start",
    strings: {
      // Keep within 5 minutes so MapVoteManager won't schedule a long closure timer.
      when: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      modifiers: "no",
      banned_classes: bannedClasses,
      map: `poll ${pollMaps}`,
      organiser: game.organiser,
      host: game.host,
      doubleelo: "no",
    },
  });

  // AnnouncementCommand expects editReply to return a message-like object.
  announceInteraction.editReply = async (_payload: any) => ({
    edit: async (_next: any) => {},
    delete: async () => {},
    embeds: [],
  });
  announceInteraction.deferReply = async () => {
    announceInteraction.deferred = true;
    return {};
  };

  await announcementCmd.execute(announceInteraction);

  const confirmInteraction: any = {
    customId: "announcement-confirm",
    guild,
    user: { id: organiser.id },
    deferReply: async () => {},
    editReply: async () => {},
  };
  await announcementCmd.handleButtonPress(confirmInteraction);

  assert(game.announced === true, "announcement should be confirmed");
  assert(!!game.mapVoteManager, "map vote manager should be created");

  const origAdd = (game as any).addPlayerByDiscordId;
  (game as any).addPlayerByDiscordId = async (
    discordSnowflake: string,
    ign: string
  ) => {
    let rec = await (prismaClient as any).player.byDiscordSnowflake(
      discordSnowflake
    );
    if (!rec) {
      rec = await (prismaClient as any).player.create({
        data: { discordSnowflake, latestIGN: ign },
      });
    }
    rec.latestIGN = ign;
    const player = {
      discordSnowflake,
      ignUsed: ign,
      elo: 1000,
      captain: false,
      playerId: rec.id,
      wins: 0,
      losses: 0,
      winStreak: 0,
      loseStreak: 0,
      biggestWinStreak: 0,
      biggestLosingStreak: 0,
    };
    game.teams.UNDECIDED.push(player as any);
    return { error: false, playerInstance: player } as const;
  };

  const register = new RegisterCommand(new TeamCommand());
  for (let i = 0; i < players.length; i++) {
    const user = players[i];
    const ign = playerNames[i];
    const interaction = createChatInputInteraction(user.id, {
      guild,
      channelId: config.channels.registration,
      strings: { ingamename: ign },
    });
    await register.execute(interaction);
  }
  assert(game.getPlayers().length === players.length, "players registered");

  const captainCmd = new CaptainCommand(new TeamCommand());
  await captainCmd.execute(
    createChatInputInteraction(organiser.id, {
      guild,
      member: organiser as any,
      strings: { user: playerNames[0], team: "blue" },
    })
  );
  await captainCmd.execute(
    createChatInputInteraction(organiser.id, {
      guild,
      member: organiser as any,
      strings: { user: playerNames[1], team: "red" },
    })
  );

  const teamCmd = new TeamCommand();
  await teamCmd.execute(
    createChatInputInteraction(organiser.id, {
      guild,
      member: organiser as any,
      strings: { method: "random" },
      subcommand: "generate",
    })
  );
  await teamCmd.handleButtonPress(
    createButtonInteraction(
      "random-team-accept",
      "",
      organiser.id,
      guild
    ) as any
  );

  const gameCmd = new GameCommand();
  await gameCmd.execute(
    createChatInputInteraction(organiser.id, {
      guild,
      member: organiser as any,
      subcommand: "start",
    })
  );

  const redCaptain = game.getCaptainOfTeam("RED")!;
  const blueCaptain = game.getCaptainOfTeam("BLUE")!;

  const classCmd = new ClassbanCommand();
  const redChan = {
    id: config.channels.redTeamChat,
    send: async (_: any) => {},
  };
  const blueChan = {
    id: config.channels.blueTeamChat,
    send: async (_: any) => {},
  };
  await classCmd.execute(
    createChatInputInteraction(redCaptain.discordSnowflake, {
      guild,
      channelId: config.channels.redTeamChat,
      channel: redChan as any,
      strings: { class: classBan.redCaptainBan },
      member: (await guild.members.fetch(redCaptain.discordSnowflake)) as any,
      subcommand: "ban",
    })
  );
  await classCmd.execute(
    createChatInputInteraction(blueCaptain.discordSnowflake, {
      guild,
      channelId: config.channels.blueTeamChat,
      channel: blueChan as any,
      strings: { class: classBan.blueCaptainBan },
      member: (await guild.members.fetch(blueCaptain.discordSnowflake)) as any,
      subcommand: "ban",
    })
  );

  await gameCmd.execute(
    createChatInputInteraction(organiser.id, {
      guild,
      member: organiser as any,
      subcommand: "end",
    })
  );
  assert(game.isFinished === true, "game finished");

  // MVP votes (exercise MVP logic twice as part of full game flow).
  const mvpCmd = new MVPCommand();
  const ensureTeammate = (teamKey: "RED" | "BLUE") => {
    const teamArr = game.getPlayersOfTeam(teamKey);
    let target = teamArr.find((p) => !p.captain);
    if (!target) {
      const otherTeam = teamKey === "RED" ? "BLUE" : "RED";
      const otherArr = game.getPlayersOfTeam(otherTeam);
      const undecided = game.getPlayersOfTeam("UNDECIDED");
      if (undecided.length > 0) {
        const moved = undecided.shift()!;
        game.teams[teamKey].push(moved as any);
        target = moved as any;
      } else if (otherArr.find((p) => !p.captain)) {
        const moved = otherArr.find((p) => !p.captain)!;
        game.teams[otherTeam] = otherArr.filter((p) => p !== moved) as any;
        game.teams[teamKey].push(moved as any);
        target = moved as any;
      }
    }
    if (!target) {
      throw new Error("No non-captain teammate available to vote for");
    }
    return target;
  };
  const blueVoteTarget = ensureTeammate("BLUE");
  const redVoteTarget = ensureTeammate("RED");

  await mvpCmd.execute(
    createChatInputInteraction(blueCaptain.discordSnowflake, {
      guild,
      channelId: config.channels.blueTeamChat,
      strings: { player: blueVoteTarget.ignUsed ?? null },
      subcommand: "vote",
    })
  );
  await mvpCmd.execute(
    createChatInputInteraction(redCaptain.discordSnowflake, {
      guild,
      channelId: config.channels.redTeamChat,
      strings: { player: redVoteTarget.ignUsed ?? null },
      subcommand: "vote",
    })
  );

  const winnerCmd = new WinnerCommand();
  const winnerInteraction = createChatInputInteraction(organiser.id, {
    guild,
    member: organiser as any,
    strings: { team: "BLUE" },
    subcommand: "set",
  });
  winnerInteraction.fetchReply = async () => ({ id: "winner-msg" }) as any;
  await winnerCmd.execute(winnerInteraction);
  await winnerCmd.handleButtonPress({
    customId: "winner_confirm_yes",
    message: { id: "winner-msg" },
    user: { id: organiser.id },
    update: async (_payload: any) => {},
    reply: async (_payload: any) => {},
  } as any);

  // Shutdown triggers cleanup + resets.
  await gameCmd.execute(
    createChatInputInteraction(organiser.id, {
      guild,
      member: organiser as any,
      subcommand: "shutdown",
    })
  );

  // Restore overridden method
  (game as any).addPlayerByDiscordId = origAdd;
}

test("Two consecutive games: cleanup prevents stale state and scheduled tasks leaking", async () => {
  const config = ConfigManager.getConfig();
  const organiserRole = config.roles.organiserRole || "organiser";

  // Prevent real restarts from shutting down the test runner.
  const origRestart = RestartCommand.prototype.restartBot;
  RestartCommand.prototype.restartBot = () => {};

  const origSetTimeout = global.setTimeout;

  // Stub side effects: messages/VC/roles, feeds, DB, and Mojang.
  const sent: any[] = [];
  const origSend = DiscordUtil.sendMessage;
  const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
  const origMoveToVC = (DiscordUtil as any).moveToVC;
  const origAssignRole = (DiscordUtil as any).assignRole;
  const origBatchRem = (DiscordUtil as any).batchRemoveRoleFromMembers;
  const origBatchMove = (DiscordUtil as any).batchMoveMembersToChannel;

  (DiscordUtil as any).sendMessage = async (_ch: any, content: any) => {
    sent.push(content);
  };
  (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
  (DiscordUtil as any).moveToVC = async () => {};
  (DiscordUtil as any).assignRole = async () => {};
  (DiscordUtil as any).batchRemoveRoleFromMembers = async () => {};
  (DiscordUtil as any).batchMoveMembersToChannel = async () => {};

  const makeSendableChannel = (id: string) => ({
    id,
    isSendable: () => true,
    isTextBased: () => true,
    send: async (_payload: any) => ({
      id: `msg-${Math.random()}`,
      delete: async () => {},
      edit: async () => {},
      fetch: async () => ({ poll: null }),
      embeds: [],
      poll: null,
    }),
    messages: {
      fetch: async () => null,
    },
  });

  (Channels as any).announcements = makeSendableChannel(
    config.channels.announcements
  );
  (Channels as any).registration = makeSendableChannel(
    config.channels.registration
  );
  (Channels as any).gameFeed = {
    id: config.channels.gameFeed,
    isSendable: () => true,
    send: async (_: any) => ({
      id: `msg-${Math.random()}`,
      delete: async () => {},
      edit: async () => {},
      embeds: [],
    }),
    messages: {
      fetch: async () => null,
    },
  } as any;

  stubPrismaAndMojang();

  // Setup a fake guild with organiser + 10 players.
  const guild = new FakeGuild() as any;
  const organiser = new FakeGuildMember("org");
  await organiser.roles.add(organiserRole);
  makeRoleManagerLike(organiser.roles);
  guild.addMember(organiser);

  const players: FakeGuildMember[] = [];
  const playerNames: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const id = `p${i}`;
    const ign = `G${i}`;
    const member = new FakeGuildMember(id);
    guild.addMember(member);
    players.push(member);
    playerNames.push(ign);
  }

  // Also create a captain plan DM session and ensure reset clears it.
  const dmManager = new CaptainPlanDMManager();
  await dmManager.startForCaptain({
    client: {
      users: {
        fetch: async () =>
          ({
            id: "cap-dm",
            bot: false,
            send: async () => ({ edit: async () => {} }),
          }) as any,
      },
    } as any,
    captainId: "cap-dm",
    team: "RED",
    teamList: "A\nB",
    members: [
      { id: "cap-dm", ign: "A" },
      { id: "p1", ign: "B" },
    ],
  });
  assert(
    dmManager.hasPendingSession("cap-dm"),
    "sanity: DM session should be pending before reset"
  );

  // Leak simulation: a scheduled task that would mutate the next game's map if not canceled.
  let leakedTaskFired = false;
  Scheduler.schedule(
    "mapVote",
    () => {
      leakedTaskFired = true;
      CurrentGameManager.getCurrentGame().settings.map = "AFTERMATH1V1" as any;
    },
    new Date(Date.now() + 150)
  );

  // Game 1
  await runOneGame({
    gameNumber: 1,
    guild,
    organiser,
    players,
    playerNames,
    pollMaps: "DUELSTAL, ANDORRA1V1",
    bannedClasses: "acrobat",
    classBan: { redCaptainBan: "scout", blueCaptainBan: "transporter" },
  });

  // Wait long enough that the leaked Scheduler task would have fired if not canceled.
  await sleep(250);
  assert(
    leakedTaskFired === false,
    "scheduled task should not fire after reset"
  );

  // Verify game state is reset between games.
  const afterFirst = CurrentGameManager.getCurrentGame();
  assert(afterFirst.getPlayers().length === 0, "players cleared after game 1");
  assert(afterFirst.announced === false, "announced reset after game 1");
  assert(
    afterFirst.isFinished === undefined,
    "isFinished cleared after game 1"
  );
  assert(
    afterFirst.settings.organiserBannedClasses.length === 0,
    "banned classes cleared after game 1"
  );
  assert(
    afterFirst.settings.modifiers.length === 0,
    "modifiers cleared after game 1"
  );
  assert(
    dmManager.hasPendingSession("cap-dm") === false,
    "captain DM sessions cleared after reset"
  );

  // Game 2 (different announced map and bans) should behave like a fresh process.
  await runOneGame({
    gameNumber: 2,
    guild,
    organiser,
    players,
    playerNames,
    pollMaps: "AFTERMATH1V1, ANDORRA1V1",
    bannedClasses: "berserker",
    classBan: { redCaptainBan: "acrobat", blueCaptainBan: "berserker" },
  });

  const afterSecond = CurrentGameManager.getCurrentGame();
  assert(afterSecond.getPlayers().length === 0, "players cleared after game 2");
  assert(afterSecond.settings.map === undefined, "map cleared after game 2");

  // Cleanup patches
  RestartCommand.prototype.restartBot = origRestart;
  (global as any).setTimeout = origSetTimeout as any;
  (DiscordUtil as any).sendMessage = origSend;
  (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
  (DiscordUtil as any).moveToVC = origMoveToVC;
  (DiscordUtil as any).assignRole = origAssignRole;
  (DiscordUtil as any).batchRemoveRoleFromMembers = origBatchRem;
  (DiscordUtil as any).batchMoveMembersToChannel = origBatchMove;
});
