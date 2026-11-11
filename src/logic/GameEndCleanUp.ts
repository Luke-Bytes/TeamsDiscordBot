import { Guild } from "discord.js";
import { MatchCleanupState } from "@prisma/client";
import { ConfigManager } from "../ConfigManager.js";
import { prismaClient } from "../database/prismaClient";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { gameFeed } from "../logic/gameFeed/GameFeed";
import { DiscordUtil } from "../util/DiscordUtil";
import { LeaderBoardFeed } from "../logic/gameFeed/LeaderBoardFeed";
import { Channels } from "../Channels";
import RestartCommand from "../commands/RestartCommand";
import { Scheduler } from "../util/SchedulerUtil";
import { SeasonService } from "../database/SeasonService";

export async function cleanUpAfterGame(guild: Guild) {
  const game = CurrentGameManager.getCurrentGame();
  const token = game.getLifecycleToken();
  const matchId = game.gameId ?? token;
  const cleanupStartedAt = Date.now();
  console.info(`event=match.cleanup game=${matchId} outcome=started`);
  // Authoritative DB commitment must precede potentially partial Discord cleanup.
  // A failed/uncertain commit leaves the in-memory result intact for inspection.
  await game.countMVPVotes();
  await prismaClient.game.saveGameFromInstance(game);
  console.info(`event=match.persist game=${matchId} outcome=succeeded duration_ms=${Date.now() - cleanupStartedAt}`);
  Scheduler.cancel("mapVote");
  Scheduler.cancel("minerushVote");
  const config = ConfigManager.getConfig();
  const blueTeamRoleId = config.roles.blueTeamRole;
  const redTeamRoleId = config.roles.redTeamRole;
  const teamPickingVCId = config.channels.teamPickingVC;
  const blueTeamVCId = config.channels.blueTeamVC;
  const redTeamVCId = config.channels.redTeamVC;
  const roleIds = [blueTeamRoleId, redTeamRoleId];
  const BATCH_SIZE = 5;
  const DELAY_MS = 200;
  const cleanupFailures: string[] = [];

  try {
    for (const roleId of roleIds) {
      await DiscordUtil.batchRemoveRoleFromMembers(
        guild,
        roleId,
        BATCH_SIZE,
        DELAY_MS
      );
    }
    console.log("Completed cleaning up roles.");
  } catch (error) {
    console.error(`[match-shutdown] role cleanup failed match=${game.gameId ?? token}`, error);
    cleanupFailures.push("team roles");
  }

  try {
    await DiscordUtil.batchMoveMembersToChannel(
      guild,
      blueTeamVCId,
      teamPickingVCId,
      BATCH_SIZE,
      DELAY_MS
    );
    await DiscordUtil.batchMoveMembersToChannel(
      guild,
      redTeamVCId,
      teamPickingVCId,
      BATCH_SIZE,
      DELAY_MS
    );
    console.log("Completed moving members to Team Picking VC.");
  } catch (error) {
    console.error(`[match-shutdown] voice cleanup failed match=${game.gameId ?? token}`, error);
    cleanupFailures.push("voice channels");
  }
  gameFeed.removeAllFeedMessages();
  const messageText = `🎉 **The Game is Over!** 🎉\n🏅 **Winning Team:** ${game.gameWinner}\n👏 Thanks for playing everyone, and a special thanks to ${game.host} for hosting!`;

  await DiscordUtil.sendMessage("gameFeed", messageText);

  // Do not reset the only in-memory cleanup context yet.
  // Failure handling below must retain the original match token and result.
  await DiscordUtil.sendMessage("gameFeed", "\u200b");
  const leaderboardFeed = new LeaderBoardFeed();
  const leaderboardEmbed = await leaderboardFeed.generateEmbed();
  await Channels.gameFeed.send({ embeds: [leaderboardEmbed] });

  const captainRoleId = config.roles.captainRole;

  try {
    if (!guild.roles?.cache) {
      console.warn(
        "[Cleanup] Guild roles cache unavailable; captain cleanup unverified."
      );
      cleanupFailures.push("captain role cache unavailable");
    } else {
      const captainRole = guild.roles.cache.get(captainRoleId);
      if (captainRole) {
        for (const [, member] of captainRole.members) {
          try {
            await member.roles.remove(captainRole);
            console.log(`Removed Captain role from ${member.user.tag}`);
          } catch (error) {
            console.error(
              `[match-shutdown] captain role cleanup failed match=${game.gameId ?? token}`,
              error
            );
            cleanupFailures.push("captain role");
          }
        }
        console.log("Completed cleaning up captains.");
      } else {
        console.error("Captain role not found.");
        cleanupFailures.push("captain role unavailable");
      }
    }
  } catch (error) {
    console.error("Failed to clean up captains:", error);
    cleanupFailures.push("captain roles");
  }

  const chatChannelIds = [
    config.channels.blueTeamChat,
    config.channels.redTeamChat,
    config.channels.teamPickingChat,
    config.channels.registration,
  ];

  try {
    await DiscordUtil.cleanUpAllChannelMessages(guild, chatChannelIds);
  } catch (error) {
    console.error("Failed to clean up messages:", error);
    cleanupFailures.push("messages");
  }

  if (game.getLifecycleToken() !== token || cleanupFailures.length) {
    throw new Error(
      `Match ${game.gameId ?? token} committed, but cleanup requires operator reconciliation: ${cleanupFailures.join(", ") || "lifecycle changed"}`
    );
  }
  await SeasonService.afterGameSaved();
  // Persist the checkpoint BEFORE resetting the only available match context.
  // If the acknowledgement is lost, read the durable state rather than guessing.
  try {
    const marked = await prismaClient.game.updateMany({
      where: { id: matchId, cleanupState: MatchCleanupState.PENDING },
      data: { cleanupState: MatchCleanupState.COMPLETE, cleanupCompletedAt: new Date() },
    });
    if (marked.count !== 1) {
      const current = await prismaClient.game.findUnique({ where: { id: matchId } });
      if (current?.cleanupState !== MatchCleanupState.COMPLETE) {
        throw new Error("Cleanup checkpoint not confirmed");
      }
    }
  } catch (error) {
    const current = await prismaClient.game.findUnique({ where: { id: matchId } }).catch(() => null);
    if (current?.cleanupState !== MatchCleanupState.COMPLETE) {
      console.error(`[match-shutdown] checkpoint unknown match=${matchId}`, error);
      throw new Error(`Match ${matchId} external cleanup was attempted but checkpoint is uncertain; operator reconciliation required`);
    }
  }
  await CurrentGameManager.resetCurrentGame();
  console.info(`event=match.cleanup game=${matchId} outcome=succeeded duration_ms=${Date.now() - cleanupStartedAt}`);
  await new Promise((resolve) => setTimeout(resolve, 10 * 1000));
  const restartCommand = new RestartCommand();
  restartCommand.restartBot();
}
