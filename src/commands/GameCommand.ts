import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  Guild,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { ConfigManager } from "../ConfigManager";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { GameInstance } from "../database/GameInstance";
import { cleanUpAfterGame } from "../logic/GameEndCleanUp";
import { DiscordUtil } from "../util/DiscordUtil";
import { setTimeout as delay } from "timers/promises";
import { checkMissingPlayersInVC, formatTeamIGNs } from "../util/Utils";

export default class GameCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("game")
    .setDescription("Manage game sessions")
    .addSubcommand((sub) =>
      sub.setName("start").setDescription("Move players to team vcs")
    )
    .addSubcommand((sub) =>
      sub
        .setName("end")
        .setDescription("Move players to 1 vc and start MVP vote")
    )
    .addSubcommand((sub) =>
      sub
        .setName("shutdown")
        .setDescription("Complete the game and calculate elo")
    );

  name = "game";
  description = "Manage game session";
  buttonIds: string[] = [];

  async execute(interaction: ChatInputCommandInteraction) {
    const subCommand = interaction.options.getSubcommand();
    const isAuthorized = await PermissionsUtil.isUserAuthorised(interaction);
    if (!isAuthorized) return;
    const guild = interaction.guild!;
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

          await DiscordUtil.sendMessage(
            "redTeamChat",
            `Welcome to the red team! This is the planning phase. Please be ready to join the event server ⚔️`
          );

          await DiscordUtil.sendMessage(
            "blueTeamChat",
            `Welcome to the blue team! This is the planning phase. Please be ready to join the event server ⚔️`
          );

          await checkMissingPlayersInVC(
            interaction.guild!,
            "RED",
            async (msg) => {
              await DiscordUtil.sendMessage("redTeamChat", `${msg}`);
            }
          );
          await checkMissingPlayersInVC(
            interaction.guild!,
            "BLUE",
            async (msg) => {
              await DiscordUtil.sendMessage("blueTeamChat", `${msg}`);
            }
          );

          const redNamesFormatted = await formatTeamIGNs(gameInstance, "RED");
          const blueNamesFormatted = await formatTeamIGNs(gameInstance, "BLUE");
          await DiscordUtil.sendMessage(
            "redTeamChat",
            `**Mid Blocks Plan**\n\`\`\`\n${redNamesFormatted}\n\`\`\`\n**Game Plan**\n\`\`\`\n${redNamesFormatted}\n\`\`\``
          );
          await DiscordUtil.sendMessage(
            "blueTeamChat",
            `**Mid Blocks Plan**\n\`\`\`\n${blueNamesFormatted}\n\`\`\`\n**Game Plan**\n\`\`\`\n${blueNamesFormatted}\n\`\`\``
          );
        } catch (error) {
          console.error("Error starting the game: ", error);
          await interaction.editReply({
            content: "Failed to start the game.",
          });
        }
        break;

      case "end": {
        gameInstance.isFinished = true;
        await interaction.reply(
          "Moving players back to team picking and starting MVP votes.."
        );
        await movePlayersToTeamPickingAfterGameEnd(guild);

        const config = ConfigManager.getConfig();
        const blueTeamRoleId = config.roles.blueTeamRole;
        const redTeamRoleId = config.roles.redTeamRole;

        await DiscordUtil.sendMessage(
          "redTeamChat",
          `The game has now ended, voting for the team MVP is now open! Type \`/MVP Vote [MCID]\` to pick for <@&${redTeamRoleId}>!`
        );

        await DiscordUtil.sendMessage(
          "blueTeamChat",
          `The game has now ended, voting for the team MVP is now open! Type \`/MVP Vote [MCID]\` to pick for <@&${blueTeamRoleId}>!`
        );

        gameInstance.calculateMeanEloAndExpectedScore();

        break;
      }

      case "shutdown":
        if (!gameInstance.gameWinner) {
          await interaction.reply({
            content: "Please set a winner via /winner before ending the game.",
            ephemeral: false,
          });
          return;
        }
        if (!gameInstance.isFinished) {
          await interaction.reply({
            content:
              "The game should be finished first in order to wait for mvp votes, /game end",
            ephemeral: false,
          });
          return;
        }
        if (gameInstance.isRestarting) {
          await interaction.reply({
            content: "A game shutdown is already in progress!",
            ephemeral: false,
          });
          return;
        }
        GameInstance.getInstance().isRestarting = true;
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

export async function assignTeamVCAfterPicking(guild: Guild) {
  const config = ConfigManager.getConfig();
  const blueTeamRoleId = config.roles.blueTeamRole;
  const redTeamRoleId = config.roles.redTeamRole;

  const gameInstance = GameInstance.getInstance();

  try {
    const redPlayers = gameInstance.getPlayersOfTeam("RED");
    for (const player of redPlayers) {
      await DiscordUtil.moveToVC(
        guild,
        config.channels.redTeamVC,
        redTeamRoleId,
        player.discordSnowflake
      );
    }

    const bluePlayers = gameInstance.getPlayersOfTeam("BLUE");
    for (const player of bluePlayers) {
      await DiscordUtil.moveToVC(
        guild,
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

  const BATCH_SIZE = 5;
  const DELAY_MS = 200;

  async function assignRolesForTeam(team: "RED" | "BLUE", roleId: string) {
    const players = gameInstance.getPlayersOfTeam(team);

    for (let i = 0; i < players.length; i += BATCH_SIZE) {
      const batch = players.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async (player) => {
          try {
            const member = await guild.members.fetch(player.discordSnowflake);
            if (member) {
              await DiscordUtil.assignRole(member, roleId);
            }
          } catch (error) {
            console.error(
              `Failed to assign role to ${player.discordSnowflake}:`,
              error
            );
          }
        })
      );

      if (i + BATCH_SIZE < players.length) {
        await delay(DELAY_MS);
      }
    }
  }

  try {
    await assignRolesForTeam("RED", redTeamRoleId);
    await assignRolesForTeam("BLUE", blueTeamRoleId);
    console.log("Roles assigned successfully for both teams.");
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
        for (const [, member] of voiceChannel.members) {
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
    await moveMembers(config.channels.yellowTeamVC);
    await moveMembers(config.channels.greenTeamVC);

    console.log("Completed cleaning up members.");
  } catch (error) {
    console.error("Failed to move members to vc:", error);
  }
}
