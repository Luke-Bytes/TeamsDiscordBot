import { Guild, TextChannel } from "discord.js";
import { ConfigManager } from "../ConfigManager.js";
import { GameInstance } from "../database/GameInstance.js";

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

  try {
    const chatChannelIds = [
      config.channels.blueTeamChat,
      config.channels.redTeamChat,
      config.channels.teamPickingChat,
      config.channels.registration,
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
  //FIXME why isnt it resetting announcements
  await GameInstance.resetGameInstance();
  console.log("Game instance reset to default values.");
}
