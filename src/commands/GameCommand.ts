import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  GuildMember,
  Guild,
  Snowflake,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { ConfigManager } from "../ConfigManager";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { GameInstance } from "../database/GameInstance";
import { cleanUpAfterGame } from "../logic/GameEndCleanUp";

export default class GameCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("game")
    .setDescription("Manage game sessions")
    .addSubcommand((sub) =>
      sub.setName("start").setDescription("Move players to team vcs")
    )
    .addSubcommand((sub) =>
      sub.setName("end").setDescription("Move players to 1 vc")
    )
    .addSubcommand((sub) =>
      sub.setName("finish").setDescription("End the game and calculate elo")
    );

  name = "game";
  description = "Manage game session";
  buttonIds: string[] = [];

  async execute(interaction: ChatInputCommandInteraction) {
    const subCommand = interaction.options.getSubcommand();
    const member = interaction.member as GuildMember;

    if (!member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.reply({
        content: "You do not have permission to run this command.",
        ephemeral: false,
      });
      return;
    }
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }
    const gameInstance = GameInstance.getInstance();
    switch (subCommand) {
      case "start":
        await interaction.deferReply({ ephemeral: false });
        try {
          await assignTeamRolesAfterPicking(guild);
          await assignTeamVCAfterPicking(guild);

          await interaction.editReply(
            "Game will begin soon! Roles assigned and players moved to VCs."
          );
        } catch (error) {
          console.error("Error starting the game:", error);
          await interaction.editReply({
            content: "Failed to start the game.",
          });
        }
        break;

      case "end":
        gameInstance.isFinished = true;
        await interaction.reply("Moving players back to team picking..");
        await movePlayersToTeamPickingAfterGameEnd(guild);
        break;

      case "finish":
        if (!gameInstance.gameWinner) {
          await interaction.reply({
            content: "Please set a winner via /winner before ending the game.",
            ephemeral: false,
          });
          return;
        }
        gameInstance.isFinished = true;
        await interaction.reply(
          "Beginning post game clean up of channels and calculating elo.."
        );
        await cleanUpAfterGame(guild);
        break;

      default:
        await interaction.reply("Invalid subcommand.");
    }
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function assignTeamVCAfterPicking(guild: Guild) {
  const config = ConfigManager.getConfig();
  const blueTeamRoleId = config.roles.blueTeamRole;
  const redTeamRoleId = config.roles.redTeamRole;

  const gameInstance = GameInstance.getInstance();

  const movePlayerToTeamVC = async (
    vcId: string,
    roleId: string,
    discordSnowflake: Snowflake
  ) => {
    const voiceChannel = guild.channels.cache.get(vcId);
    const role = guild.roles.cache.get(roleId);

    if (!voiceChannel || !role || !voiceChannel.isVoiceBased()) {
      console.error(`Invalid setup for VC: ${vcId} or Role: ${roleId}`);
      return;
    }

    try {
      const member = await guild.members.fetch(discordSnowflake);
      if (
        !member.roles.cache.has(roleId) ||
        member.voice.channel?.id === vcId
      ) {
        return;
      }

      console.log(
        `Attempting to move ${member.user.tag} to ${voiceChannel.name}`
      );
      await member.voice.setChannel(voiceChannel);
      console.log(
        `Successfully moved ${member.user.tag} to ${voiceChannel.name}`
      );
    } catch (error) {
      console.error(
        `Failed to move member ${discordSnowflake} to ${voiceChannel?.name}: `,
        error
      );
    }
  };

  try {
    const redPlayers = gameInstance.getPlayersOfTeam("RED");
    for (const player of redPlayers) {
      await movePlayerToTeamVC(
        config.channels.redTeamVC,
        redTeamRoleId,
        player.discordSnowflake
      );
    }

    const bluePlayers = gameInstance.getPlayersOfTeam("BLUE");
    for (const player of bluePlayers) {
      await movePlayerToTeamVC(
        config.channels.blueTeamVC,
        blueTeamRoleId,
        player.discordSnowflake
      );
    }

    console.log("Finished assigning players to team voice channels.");
  } catch (error) {
    console.error("Unexpected error during team VC assignment:", error);
  }
}

export async function assignTeamRolesAfterPicking(guild: Guild) {
  const config = ConfigManager.getConfig();
  const blueTeamRoleId = config.roles.blueTeamRole;
  const redTeamRoleId = config.roles.redTeamRole;

  const gameInstance = GameInstance.getInstance();

  const assignRole = async (member: GuildMember, roleId: string) => {
    try {
      await member.roles.add(roleId);
      console.log(`Assigned role ${roleId} to ${member.user.tag}`);
    } catch (error) {
      console.error(
        `Failed to assign role ${roleId} to ${member.user.tag}: `,
        error
      );
    }
  };

  try {
    for (const player of gameInstance.getPlayersOfTeam("RED")) {
      const member = await guild.members.fetch(player.discordSnowflake);
      if (member) await assignRole(member, redTeamRoleId);
    }

    for (const player of gameInstance.getPlayersOfTeam("BLUE")) {
      const member = await guild.members.fetch(player.discordSnowflake);
      if (member) await assignRole(member, blueTeamRoleId);
    }
  } catch (error) {
    console.error("Error assigning roles after team picking:", error);
  }
}

export async function movePlayersToTeamPickingAfterGameEnd(guild: Guild) {
  try {
    const config = ConfigManager.getConfig();
    const teamPickingVCId = config.channels.teamPickingVC;

    const moveMembers = async (vcId: string) => {
      const voiceChannel = guild.channels.cache.get(vcId);
      if (voiceChannel && voiceChannel.isVoiceBased()) {
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
    console.error("Failed to move members to vc:", error);
  }
}
