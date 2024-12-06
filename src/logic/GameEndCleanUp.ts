import { Guild, TextChannel } from "discord.js";
import { ConfigManager } from "../ConfigManager.js";
import { GameInstance } from "../database/GameInstance.js";

export async function cleanUpAfterGame(guild: Guild) {
  const config = ConfigManager.getConfig();
  const captainRoleId = config.roles.captainRole;
  const blueTeamRoleId = config.roles.blueTeamRole;
  const redTeamRoleId = config.roles.redTeamRole;
  const teamPickingVCId = config.channels.teamPickingVC;
  const blueTeamVCId = config.channels.blueTeamVC;
  const redTeamVCId = config.channels.redTeamVC;

  const chatChannelIds = [
    config.channels.blueTeamChat,
    config.channels.redTeamChat,
    config.channels.teamPickingChat,
    config.channels.registration,
  ];

  const roleIds = [captainRoleId, blueTeamRoleId, redTeamRoleId];

  try {
    await guild.members.fetch();

    for (const roleId of roleIds) {
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        console.log(`Role with ID ${roleId} not found in guild ${guild.name}`);
        continue;
      }

      // Remove roles from members
      const membersWithRole = role.members;
      for (const [_, member] of membersWithRole) {
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

    const blueTeamVC = guild.channels.cache.get(blueTeamVCId);
    const redTeamVC = guild.channels.cache.get(redTeamVCId);

    if (blueTeamVC && blueTeamVC.isVoiceBased() && blueTeamVC.members) {
      for (const [_, member] of blueTeamVC.members) {
        try {
          await member.voice.setChannel(teamPickingVCId);
          console.log(
            `Moved ${member.user.tag} from Blue Team VC to Team Picking VC`
          );
        } catch (error) {
          console.error(
            `Failed to move ${member.user.tag} from Blue Team VC: `,
            error
          );
        }
      }
    }

    if (redTeamVC && redTeamVC.isVoiceBased() && redTeamVC.members) {
      for (const [_, member] of redTeamVC.members) {
        try {
          await member.voice.setChannel(teamPickingVCId);
          console.log(
            `Moved ${member.user.tag} from Red Team VC to Team Picking VC`
          );
        } catch (error) {
          console.error(
            `Failed to move ${member.user.tag} from Red Team VC: `,
            error
          );
        }
      }
    }

    for (const channelId of chatChannelIds) {
      const channel = guild.channels.cache.get(channelId) as TextChannel;
      if (channel?.isTextBased()) {
        try {
          let fetched;
          do {
            const textChannel = channel as TextChannel;
            fetched = await textChannel.messages.fetch({ limit: 100 });
            if (fetched.size > 0) {
              await textChannel.bulkDelete(fetched);
              console.log(
                `Cleared ${fetched.size} messages in ${textChannel.name}`
              );
            }
          } while (fetched.size >= 2);
        } catch (error) {
          console.error(
            `Failed to clear messages in ${channel || "unknown channel"}: `,
            error
          );
        }
      }
    }
  } catch (error) {
    console.error(
      "Failed to clean up roles, move members, or delete messages:",
      error
    );
  }

  await GameInstance.resetGameInstance();
  console.log("Game instance reset to default values.");
}
