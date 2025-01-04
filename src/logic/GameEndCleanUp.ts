import { Guild, Message, TextChannel } from "discord.js";
import { ConfigManager } from "../ConfigManager.js";
import { GameInstance } from "../database/GameInstance.js";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { gameFeed } from "../logic/gameFeed/GameFeed";
import { DiscordUtil } from "../util/DiscordUtil";
import { LeaderBoardFeed } from "../logic/gameFeed/LeaderBoardFeed";
import { Channels } from "../Channels";

export async function cleanUpAfterGame(guild: Guild) {
  const config = ConfigManager.getConfig();
  const blueTeamRoleId = config.roles.blueTeamRole;
  const redTeamRoleId = config.roles.redTeamRole;
  const teamPickingVCId = config.channels.teamPickingVC;
  const blueTeamVCId = config.channels.blueTeamVC;
  const redTeamVCId = config.channels.redTeamVC;
  const roleIds = [blueTeamRoleId, redTeamRoleId];
  const BATCH_SIZE = 5;
  const DELAY_MS = 200;

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
    console.error("Failed to clean up roles:", error);
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
    console.error("Failed to move members:", error);
  }

  const game = CurrentGameManager.getCurrentGame();
  await game.countMVPVotes();

  const messageText = `🎉 **The Game is Over!** 🎉\n🏅 **Winning Team:** ${game.gameWinner}\n👏 Thanks for playing everyone, and a special thanks to ${game.host} for hosting!`;

  await DiscordUtil.sendMessage("gameFeed", messageText);

  //FIXME why isnt it resetting announcements
  await GameInstance.resetGameInstance();
  console.log("Game instance reset to default values.");
  gameFeed.removeAllFeedMessages();

  await DiscordUtil.sendMessage("gameFeed", "\u200b");
  const leaderboardFeed = new LeaderBoardFeed();
  const leaderboardEmbed = await leaderboardFeed.generateEmbed();
  await Channels.gameFeed.send({ embeds: [leaderboardEmbed] });

  // 5m delay before clearing all messages
  // await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));

  const captainRoleId = config.roles.captainRole;

  try {
    const captainRole = guild.roles.cache.get(captainRoleId);
    if (captainRole) {
      for (const [_, member] of captainRole.members) {
        try {
          await member.roles.remove(captainRole);
          console.log(`Removed Captain role from ${member.user.tag}`);
        } catch (error) {
          console.error(
            `Failed to remove Captain role from ${member.user.tag}:`,
            error
          );
        }
      }
      console.log("Completed cleaning up captains.");
    } else {
      console.error("Captain role not found.");
    }
  } catch (error) {
    console.error("Failed to clean up captains:", error);
  }

  try {
    const chatChannelIds = [
      config.channels.blueTeamChat,
      config.channels.redTeamChat,
      config.channels.teamPickingChat,
      config.channels.registration,
      config.channels.gameFeed,
    ];

    for (const channelId of chatChannelIds) {
      const channel = guild.channels.cache.get(channelId) as TextChannel;
      if (!channel?.isTextBased()) continue;

      while (true) {
        try {
          const messages = await channel.messages.fetch({ limit: 100 });
          if (messages.size === 0) break;

          const recentMessages: string[] = [];
          const oldMessages: Message[] = [];

          messages.forEach((msg) => {
            const isOld =
              Date.now() - msg.createdTimestamp >= 14 * 24 * 60 * 60 * 1000;
            if (isOld) {
              oldMessages.push(msg);
            } else {
              recentMessages.push(msg.id);
            }
          });

          if (recentMessages.length > 0) {
            await channel.bulkDelete(recentMessages, true);
            console.log(
              `Cleared ${recentMessages.length} recent messages in ${channel.name}`
            );
          }

          for (const msg of oldMessages) {
            await msg.delete();
            console.log(`Deleted old message ${msg.id} in ${channel.name}`);
          }
        } catch (error) {
          console.error(
            `Error cleaning messages in ${channel?.name || "unknown channel"}:`,
            error
          );
          break;
        }
      }
    }
    console.log("Completed cleaning up messages.");
  } catch (error) {
    console.error("Failed to clean up messages:", error);
  }
}
