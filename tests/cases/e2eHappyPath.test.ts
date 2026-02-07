import { test } from "../framework/test";
import { assert } from "../framework/assert";
import {
  createChatInputInteraction,
  createButtonInteraction,
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
import MVPCommand from "../../src/commands/MVPCommand";
import WinnerCommand from "../../src/commands/WinnerCommand";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { Channels } from "../../src/Channels";
import { prismaClient } from "../../src/database/prismaClient";
import { MojangAPI } from "../../src/api/MojangAPI";
import { GuildMemberRoleManager } from "discord.js";
import { withImmediateTimers } from "../framework/timers";

// Helper to set prototype so instanceof GuildMemberRoleManager passes
function makeRoleManagerLike(obj: any) {
  try {
    Object.setPrototypeOf(obj, (GuildMemberRoleManager as any).prototype);
  } catch {} // eslint-disable-line no-empty
}

test("E2E happy path: announce -> register -> nominate -> set captains -> random teams -> start -> class bans -> end -> MVP -> winner -> shutdown", () =>
  withImmediateTimers(async () => {
    const config = ConfigManager.getConfig();
    const organiserRole = config.roles.organiserRole || "organiser";
    const captainRole = config.roles.captainRole || "captain";
    const blueRole = config.roles.blueTeamRole || "blue";
    const redRole = config.roles.redTeamRole || "red";

    // Fake guild and members
    const guild = new FakeGuild() as any;
    const organiser = new FakeGuildMember("org");
    await organiser.roles.add(organiserRole);
    makeRoleManagerLike(organiser.roles);
    guild.addMember(organiser);

    const players: FakeGuildMember[] = [];
    const playerNames: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const id = `p${i}`;
      const ign = `Player${i}`;
      const member = new FakeGuildMember(id);
      guild.addMember(member);
      players.push(member);
      playerNames.push(ign);
    }

    // Stubs and captures
    const sent: any[] = [];
    const origSend = DiscordUtil.sendMessage;
    const origClean = (DiscordUtil as any).cleanUpAllChannelMessages;
    const origMoveToVC = (DiscordUtil as any).moveToVC;
    const origAssignRole = (DiscordUtil as any).assignRole;
    const origBatchRem = (DiscordUtil as any).batchRemoveRoleFromMembers;
    const origBatchMove = (DiscordUtil as any).batchMoveMembersToChannel;
    const origGameFeed = (Channels as any).gameFeed;
    const origUsernameToUUID = (MojangAPI as any).usernameToUUID;
    const origUuidToUsername = (MojangAPI as any).uuidToUsername;
    const origFindFirst = (prismaClient as any).player.findFirst;
    const origFindUnique = (prismaClient as any).player.findUnique;
    const origByDiscord = (prismaClient as any).player.byDiscordSnowflake;
    const origCreate = (prismaClient as any).player.create;
    const origUpdate = (prismaClient as any).player.update;
    const origSaveGame = (prismaClient as any).game.saveGameFromInstance;

    try {
      (DiscordUtil as any).sendMessage = async (_ch: any, content: any) => {
        sent.push(content);
      };
      (DiscordUtil as any).cleanUpAllChannelMessages = async () => {};
      (DiscordUtil as any).moveToVC = async () => {};
      (DiscordUtil as any).assignRole = async () => {};
      (DiscordUtil as any).batchRemoveRoleFromMembers = async () => {};
      (DiscordUtil as any).batchMoveMembersToChannel = async () => {};

      // Fake gameFeed channel to absorb sends
      (Channels as any).gameFeed = {
        id: config.channels.gameFeed,
        send: async (_: any) => {},
      } as any;

      // Minimal prisma + Mojang stubs for registration and player lookup
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
          )
            return p;
        }
        return null;
      };
      (prismaClient as any).player.findUnique = async ({ where }: any) => {
        if (where.discordSnowflake)
          return idToPlayer.get(where.discordSnowflake) || null;
        if (where.id)
          return (
            Array.from(idToPlayer.values()).find(
              (p: any) => p.id === where.id
            ) || null
          );
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

      // Override addPlayerByDiscordId to in-memory
      const game = CurrentGameManager.getCurrentGame();
      game.reset();
      (game as any).announced = true;
      game.settings.map = "DUELSTAL" as any;
      game.organiser = "TestOrganiser";
      game.host = "TestHost";
      (game as any).isDoubleElo = false;

      const origAdd = (game as any).addPlayerByDiscordId;
      (game as any).addPlayerByDiscordId = async (
        discordSnowflake: string,
        ign: string,
        uuid: string | null
      ) => {
        // upsert DB record
        let rec = await (prismaClient as any).player.byDiscordSnowflake(
          discordSnowflake
        );
        if (!rec)
          rec = await (prismaClient as any).player.create({
            data: { discordSnowflake, latestIGN: ign },
          });
        rec.latestIGN = ign;
        idToPlayer.set(discordSnowflake, rec);
        const player = {
          discordSnowflake,
          ignUsed: ign,
          elo: 1000,
          captain: false,
          playerId: rec.id,
        };
        game.teams.UNDECIDED.push(player as any);
        return { error: false, playerInstance: player } as const;
      };

      // Step 2: Register 10 unique players
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
      assert(
        game.getPlayers().length === 10,
        "10 players should be registered"
      );

      // Step 4: Organiser sets two players to captain (BLUE and RED)
      const captainCmd = new CaptainCommand(new TeamCommand());
      const cap1 = createChatInputInteraction(organiser.id, {
        guild,
        member: organiser as any,
        strings: { user: playerNames[0], team: "blue" },
      });
      await captainCmd.execute(cap1);
      const cap2 = createChatInputInteraction(organiser.id, {
        guild,
        member: organiser as any,
        strings: { user: playerNames[1], team: "red" },
      });
      await captainCmd.execute(cap2);
      assert(
        !!game.getCaptainOfTeam("BLUE") && !!game.getCaptainOfTeam("RED"),
        "Both teams have captains"
      );

      // Step 5: Organiser generates random teams and accepts via button
      const teamCmd = new TeamCommand();
      const gen = createChatInputInteraction(organiser.id, {
        guild,
        member: organiser as any,
        strings: { method: "random" },
        subcommand: "generate",
      });
      await teamCmd.execute(gen);
      const accept = createButtonInteraction(
        "random-team-accept",
        "",
        organiser.id,
        guild
      );
      await teamCmd.handleButtonPress(accept as any);

      // Step 6: Organiser starts game
      const gameCmd = new GameCommand();
      const start = createChatInputInteraction(organiser.id, {
        guild,
        member: organiser as any,
        subcommand: "start",
      });
      await gameCmd.execute(start);

      // Captains and team roles are assigned by CaptainCommand already
      const blueCaptain = game.getCaptainOfTeam("BLUE")!;
      const redCaptain = game.getCaptainOfTeam("RED")!;

      // Step 7: Two captains ban a class each
      const classCmd = new ClassbanCommand();
      const redChan = {
        id: config.channels.redTeamChat,
        send: async (_: any) => {},
      };
      const blueChan = {
        id: config.channels.blueTeamChat,
        send: async (_: any) => {},
      };
      const ban1 = createChatInputInteraction(redCaptain.discordSnowflake, {
        guild,
        channelId: config.channels.redTeamChat,
        channel: redChan as any,
        strings: { class: "scout" },
        member: (await guild.members.fetch(redCaptain.discordSnowflake)) as any,
        subcommand: "ban",
      });
      await classCmd.execute(ban1);
      const ban2 = createChatInputInteraction(blueCaptain.discordSnowflake, {
        guild,
        channelId: config.channels.blueTeamChat,
        channel: blueChan as any,
        strings: { class: "transporter" },
        member: (await guild.members.fetch(
          blueCaptain.discordSnowflake
        )) as any,
        subcommand: "ban",
      });
      await classCmd.execute(ban2);

      // Step 8: Organiser ends game
      const end = createChatInputInteraction(organiser.id, {
        guild,
        member: organiser as any,
        subcommand: "end",
      });
      await gameCmd.execute(end);
      assert(
        CurrentGameManager.getCurrentGame().isFinished === true,
        "Game should be marked finished"
      );

      // Step 9: Captains vote MVPs for teammates on their own channels
      const mvpCmd = new MVPCommand();
      const ensureTeammate = (team: "RED" | "BLUE") => {
        const teamArr = game.getPlayersOfTeam(team);
        let target = teamArr.find((p) => !p.captain);
        if (!target) {
          const otherTeam = team === "RED" ? "BLUE" : "RED";
          const otherArr = game.getPlayersOfTeam(otherTeam);
          const undecided = game.getPlayersOfTeam("UNDECIDED");
          if (undecided.length > 0) {
            const moved = undecided.shift()!;
            game.teams[team].push(moved as any);
            target = moved as any;
          } else if (otherArr.find((p) => !p.captain)) {
            const moved = otherArr.find((p) => !p.captain)!;
            game.teams[otherTeam] = otherArr.filter((p) => p !== moved) as any;
            game.teams[team].push(moved as any);
            target = moved as any;
          }
        }
        return target!;
      };
      const blueVoteTarget = ensureTeammate("BLUE");
      const redVoteTarget = ensureTeammate("RED");

      const mvp1 = createChatInputInteraction(blueCaptain.discordSnowflake, {
        guild,
        channelId: config.channels.blueTeamChat,
        strings: { player: blueVoteTarget.ignUsed ?? null },
        subcommand: "vote",
      });
      await mvpCmd.execute(mvp1);
      const mvp2 = createChatInputInteraction(redCaptain.discordSnowflake, {
        guild,
        channelId: config.channels.redTeamChat,
        strings: { player: redVoteTarget.ignUsed ?? null },
        subcommand: "vote",
      });
      await mvpCmd.execute(mvp2);

      // Step 10: Organiser sets winner BLUE
      const winnerCmd = new WinnerCommand();
      const win = createChatInputInteraction(organiser.id, {
        guild,
        member: organiser as any,
        strings: { team: "BLUE" },
        subcommand: "set",
      });
      await winnerCmd.execute(win);
      await winnerCmd.handleButtonPress({
        customId: "winner_confirm_yes",
        message: { id: "msg-1" },
        user: { id: organiser.id },
        update: async (_payload: any) => {},
        reply: async (_payload: any) => {},
      } as any);
      assert(game.gameWinner === "BLUE", "Winner should be BLUE");

      // Step 11: Organiser shuts the game down
      const origExit = process.exit;
      process.exit = ((code?: number) => {
        console.log("Intercepted exit", code);
      }) as any;
      (prismaClient as any).game.saveGameFromInstance = async () => {};
      const shut = createChatInputInteraction(organiser.id, {
        guild,
        member: organiser as any,
        subcommand: "shutdown",
      });
      await gameCmd.execute(shut);
      // restore
      process.exit = origExit;
    } finally {
      (DiscordUtil as any).sendMessage = origSend;
      (DiscordUtil as any).cleanUpAllChannelMessages = origClean;
      (DiscordUtil as any).moveToVC = origMoveToVC;
      (DiscordUtil as any).assignRole = origAssignRole;
      (DiscordUtil as any).batchRemoveRoleFromMembers = origBatchRem;
      (DiscordUtil as any).batchMoveMembersToChannel = origBatchMove;
      (Channels as any).gameFeed = origGameFeed;
      (MojangAPI as any).usernameToUUID = origUsernameToUUID;
      (MojangAPI as any).uuidToUsername = origUuidToUsername;
      (prismaClient as any).player.findFirst = origFindFirst;
      (prismaClient as any).player.findUnique = origFindUnique;
      (prismaClient as any).player.byDiscordSnowflake = origByDiscord;
      (prismaClient as any).player.create = origCreate;
      (prismaClient as any).player.update = origUpdate;
      (prismaClient as any).game.saveGameFromInstance = origSaveGame;
    }
  }));
