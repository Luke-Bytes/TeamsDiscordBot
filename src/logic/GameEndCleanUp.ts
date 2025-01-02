import { Guild, TextChannel } from "discord.js";
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
  const roleIds = [blueTeamRoleId, redTeamRoleId];

  try {
    for (const roleId of roleIds) {
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        console.log(`Role with ID ${roleId} not found in guild ${guild.name}`);
        continue;
      }

      // Filters by blue + red roles
      for (const [_, member] of role.members) {
        try {
          await member.roles.remove(role);
          console.log(`Removed role ${role.name} from ${member.user.tag}`);
        } catch (error) {
          console.error(
            `Failed to remove role ${role.name} from ${member.user.tag}: `,
            error
          );
        }
      }
    }

    const moveMembers = async (vcId: string) => {
      const voiceChannel = guild.channels.cache.get(vcId);
      if (voiceChannel && voiceChannel.isVoiceBased() && voiceChannel.members) {
        for (const [_, member] of voiceChannel.members) {
          try {
            await member.voice.setChannel(teamPickingVCId);
            console.log(
              `Moved ${member.user.tag} from ${voiceChannel.name} to Team Picking VC`
            );
          } catch (error) {
            console.error(
              `Failed to move ${member.user.tag} from ${voiceChannel.name}: `,
              error
            );
          }
        }
      }
    };

    await moveMembers(config.channels.blueTeamVC);
    await moveMembers(config.channels.redTeamVC);

    console.log("Completed cleaning up members.");
  } catch (error) {
    console.error("Failed to clean up roles or move members:", error);
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
  await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));

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
      if (channel?.isTextBased()) {
        try {
          let fetched;
          do {
            fetched = await channel.messages.fetch({ limit: 100 });

            const recentMessages = fetched.filter(
              (msg) =>
                Date.now() - msg.createdTimestamp < 14 * 24 * 60 * 60 * 1000
            );

            if (recentMessages.size > 0) {
              await channel.bulkDelete(recentMessages);
              console.log(
                `Cleared ${recentMessages.size} recent messages in ${channel.name}`
              );
            }

            const oldMessages = fetched.filter(
              (msg) =>
                Date.now() - msg.createdTimestamp >= 14 * 24 * 60 * 60 * 1000
            );

            for (const [id, msg] of oldMessages) {
              try {
                await msg.delete();
                console.log(`Deleted old message ${msg.id} in ${channel.name}`);
              } catch (error) {
                console.error(`Failed to delete old message ${msg.id}:`, error);
              }
            }
          } while (fetched.size >= 2);
        } catch (error) {
          console.error(
            `Failed to clean up messages in ${channel?.name || "unknown channel"}:`,
            error
          );
        }
      }
    }

    console.log("Completed cleaning up messages.");
  } catch (error) {
    console.error("Failed to clean up messages:", error);
  }
}
