import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  GuildMemberRoleManager,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { ConfigManager } from "../ConfigManager";
import { GameInstance } from "../database/GameInstance";
import { PlayerInstance } from "../database/PlayerInstance";
import { DraftTeamPickingSession } from "../logic/teams/DraftTeamPickingSession";
import { RandomTeamPickingSession } from "../logic/teams/RandomTeamPickingSession";
import { TeamPickingSession } from "../logic/teams/TeamPickingSession";
import { DiscordUtil } from "../util/DiscordUtil";
import { PermissionsUtil } from "../util/PermissionsUtil";

export default class TeamCommand implements Command {
  public data: SlashCommandSubcommandsOnlyBuilder;
  public name = "team";
  public description = "Manage teams";
  public buttonIds: string[] = [
    "random-team-accept",
    "random-team-generate-reroll",
    "random-team-generate-cancel",
    "draft-accept",
    "draft-cancel",
  ];

  teamPickingSession?: TeamPickingSession;

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addSubcommand((subcommand) =>
        subcommand
          .setName("generate")
          .setDescription("Generate teams")
          .addStringOption((option) =>
            option
              .setName("method")
              .setDescription("Method to generate teams")
              .setRequired(true)
              .addChoices(
                { name: "random", value: "random" },
                {
                  name: "draft",
                  value: "draft",
                }
              )
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("reset").setDescription("Reset the teams")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("List the current teams")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("cancel")
          .setDescription("Cancel the current team picking session")
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = ConfigManager.getConfig();
    const subcommand = interaction.options.getSubcommand();
    const member = DiscordUtil.getGuildMember(interaction);
    const isOrganiser =
      member?.roles instanceof GuildMemberRoleManager &&
      member.roles.cache.has(config.roles.organiserRole);

    const game = CurrentGameManager.getCurrentGame();

    try {
      switch (subcommand) {
        case "generate": {
          if (!isOrganiser) {
            await DiscordUtil.reply(
              interaction,
              "You do not have permission to run this command!"
            );
            return;
          }

          if (!game.announced) {
            await DiscordUtil.reply(
              interaction,
              "A game has not been announced yet. Please use `/announce start`."
            );
            return;
          }

          if (this.teamPickingSession) {
            await DiscordUtil.reply(
              interaction,
              "A team picking session is already in process. Cancel that one before creating another."
            );
            return;
          }
          const method = interaction.options.getString("method");
          if (
            method === "draft" &&
            !game.getCaptainOfTeam("RED") &&
            !game.getCaptainOfTeam("BLUE")
          ) {
            await DiscordUtil.reply(
              interaction,
              "You can't draft teams without setting captains for both teams first!"
            );
            return;
          }

          await interaction.deferReply({ ephemeral: false });

          switch (method) {
            case "random":
              this.teamPickingSession = new RandomTeamPickingSession();
              await this.teamPickingSession.initialize(interaction);
              break;
            case "draft":
              this.teamPickingSession = new DraftTeamPickingSession();
              await this.teamPickingSession.initialize(interaction);
              break;
          }

          const redTeam = game.getPlayersOfTeam("RED");
          const blueTeam = game.getPlayersOfTeam("BLUE");

          for (const player of redTeam) {
            if (
              !DiscordUtil.isValidSnowflake(player.discordSnowflake) &&
              PermissionsUtil.isDebugEnabled()
            ) {
              console.log(
                `Skipping invalid snowflake as probably a fake player: ${player.discordSnowflake}`
              );
              continue;
            }

            try {
              const discordUser = await interaction.guild?.members.fetch(
                player.discordSnowflake
              );
              if (discordUser) {
                await discordUser.roles.remove(config.roles.blueTeamRole);
                await discordUser.roles.add(config.roles.redTeamRole);
              }
            } catch (error) {
              if (!PermissionsUtil.isDebugEnabled()) {
                console.error(
                  `Failed to assign role for ${player.discordSnowflake}:`,
                  error
                );
              }
            }
          }

          for (const player of blueTeam) {
            if (
              !DiscordUtil.isValidSnowflake(player.discordSnowflake) &&
              PermissionsUtil.isDebugEnabled()
            ) {
              console.log(
                `Skipping invalid snowflake as probably a fake player: ${player.discordSnowflake}`
              );
              continue;
            }

            try {
              const discordUser = await interaction.guild?.members.fetch(
                player.discordSnowflake
              );
              if (discordUser) {
                await discordUser.roles.remove(config.roles.redTeamRole);
                await discordUser.roles.add(config.roles.blueTeamRole);
              }
            } catch (error) {
              if (!PermissionsUtil.isDebugEnabled()) {
                console.error(
                  `Failed to assign role for ${player.discordSnowflake}:`,
                  error
                );
              }
            }
          }

          await DiscordUtil.editReply(interaction, {
            content: `Team picking in progress..`,
          });
          break;
        }

        case "reset": {
          if (!isOrganiser) {
            await DiscordUtil.reply(
              interaction,
              "You do not have permission to run this command!"
            );
            return;
          }

          await interaction.deferReply({ ephemeral: false });
          game.resetTeams();
          this.resetTeamPickingSession();
          await DiscordUtil.editReply(interaction, {
            content: "Teams have been reset!",
          });
          break;
        }

        case "list": {
          if (!game.announced) {
            await DiscordUtil.reply(
              interaction,
              "No game has been announced yet."
            );
          } else {
            await interaction.deferReply({ ephemeral: false });
            const embed = this.createTeamViewEmbed(game);
            await DiscordUtil.editReply(interaction, embed);
          }
          break;
        }

        case "cancel": {
          if (!isOrganiser) {
            await DiscordUtil.reply(
              interaction,
              "You do not have permission to run this command!"
            );
            return;
          }

          if (!this.teamPickingSession) {
            await DiscordUtil.reply(
              interaction,
              "No team picking session is currently active."
            );
            return;
          }

          this.resetTeamPickingSession();
          await DiscordUtil.reply(
            interaction,
            "The current team picking session has been cancelled.",
            false
          );
          break;
        }

        default:
          await DiscordUtil.reply(interaction, "Invalid subcommand!");

          if (!game.announced) {
            await interaction.reply({
              content:
                "A game has not been announced yet. Please use `/announce start`.",
              ephemeral: true,
            });
            return;
          }
      }
    } catch (error) {
      console.error(error);
      if (!interaction.replied && !interaction.deferred) {
        await DiscordUtil.reply(
          interaction,
          "An error occurred while executing this command."
        );
      }
    }
  }

  createTeamViewEmbed(game: GameInstance) {
    const redPlayers: PlayerInstance[] = game.getPlayersOfTeam("RED");
    const bluePlayers: PlayerInstance[] = game.getPlayersOfTeam("BLUE");
    const bluePlayersString =
      bluePlayers.length > 0
        ? `**${bluePlayers[0].ignUsed}**\n` +
          bluePlayers
            .slice(1)
            .map((player) => player.ignUsed)
            .join("\n") // Only the first player bold
        : "No players";

    const redPlayersString =
      redPlayers.length > 0
        ? `**${redPlayers[0].ignUsed}**\n` +
          redPlayers
            .slice(1)
            .map((player) => player.ignUsed)
            .join("\n") // Only the first player bold
        : "No players";

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Teams")
      .addFields(
        { name: "🔵 Blue Team 🔵  ", value: bluePlayersString, inline: true },
        { name: "🔴 Red Team 🔴   ", value: redPlayersString, inline: true }
      );

    return { embeds: [embed], ephemeral: false };
  }

  private async setRoles(guild: Guild) {
    const game = CurrentGameManager.getCurrentGame();
    const config = ConfigManager.getConfig();

    const redTeam = game.getPlayersOfTeam("RED");
    for (const element of redTeam) {
      const discordUser = await guild.members.fetch(element.discordSnowflake);
      await discordUser?.roles.remove(config.roles.blueTeamRole);
      discordUser?.roles.add(config.roles.redTeamRole);
    }

    const blueTeam = game.getPlayersOfTeam("BLUE");
    for (const element of blueTeam) {
      const discordUser = await guild.members.fetch(element.discordSnowflake);
      await discordUser?.roles.remove(config.roles.redTeamRole);
      discordUser?.roles.add(config.roles.blueTeamRole);
    }
  }

  public async handleButtonPress(interaction: ButtonInteraction) {
    if (!interaction.guild) return;
    if (this.teamPickingSession) {
      await this.teamPickingSession.handleInteraction(interaction);
      const state = this.teamPickingSession.getState();
      switch (state) {
        case "finalized":
          //FIXME should update original "Team picking in progress.." message to say something else too
          if (this.teamPickingSession.embedMessage) {
            const updatedEmbed = EmbedBuilder.from(
              this.teamPickingSession.embedMessage.embeds[0]
            ).setFooter({ text: "Teams have been locked." });

            await this.teamPickingSession.embedMessage.edit({
              embeds: [updatedEmbed],
              components: [],
            });
            await interaction.followUp({
              content: "Teams have been selected!",
              ephemeral: false,
            });
          }
          break;
        case "cancelled":
          this.resetTeamPickingSession();
          break;
      }
    }
  }

  private resetTeamPickingSession(): void {
    this.teamPickingSession = undefined;
  }
}
