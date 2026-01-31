import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  GuildMemberRoleManager,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  MessageFlags,
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
import { escapeText } from "../util/Utils";

export default class TeamCommand implements Command {
  static instance?: TeamCommand;
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
    TeamCommand.instance = this;
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
                { name: "draft", value: "draft" },
                { name: "elo", value: "elo" },
                { name: "balance", value: "balance" },
                { name: "random", value: "random" },
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
            (!game.getCaptainOfTeam("RED") || !game.getCaptainOfTeam("BLUE"))
          ) {
            await DiscordUtil.reply(
              interaction,
              "You can't draft teams without setting captains for both teams first!"
            );
            return;
          }

          if (method === "draft") {
            const undecidedCount = game.getPlayersOfTeam("UNDECIDED").length;
            if (undecidedCount % 2 !== 0) {
              await DiscordUtil.reply(
                interaction,
                "You need an even number of registered players to start draft team picking."
              );
              return;
            }
          }

          const teamPickingChannelIds = [config.channels.teamPickingChat];
          try {
            await DiscordUtil.cleanUpAllChannelMessages(
              interaction.guild!,
              teamPickingChannelIds
            );
          } catch (error) {
            console.error(
              "Failed to clean up team picking chat while generating teams:",
              error
            );
          }

          await interaction.deferReply();

          switch (method) {
            case "random":
              this.teamPickingSession = new RandomTeamPickingSession("random");
              await this.teamPickingSession.initialize(interaction);
              break;
            case "draft":
              this.teamPickingSession = new DraftTeamPickingSession();
              await this.teamPickingSession.initialize(interaction);
              break;
            case "elo":
              this.teamPickingSession = new RandomTeamPickingSession("elo");
              await this.teamPickingSession.initialize(interaction);
              break;
            case "balance":
              this.teamPickingSession = new RandomTeamPickingSession("balance");
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
            content: `Team picking now in progress..`,
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

          await interaction.deferReply();
          game.changeHowTeamsDecided(null);
          game.resetTeams();
          this.resetTeamPickingSession();
          try {
            const members = await interaction.guild?.members.fetch();

            if (members) {
              for (const member of members.values()) {
                if (member.roles.cache.has(config.roles.redTeamRole)) {
                  await member.roles.remove(config.roles.redTeamRole);
                }
                if (member.roles.cache.has(config.roles.blueTeamRole)) {
                  await member.roles.remove(config.roles.blueTeamRole);
                }
              }
            }
          } catch (error) {
            if (!PermissionsUtil.isDebugEnabled()) {
              console.error(`Failed to remove roles from members:`, error);
            }
          }
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
            await interaction.deferReply();
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
          game.changeHowTeamsDecided(null);
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
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
      }
    } catch (error) {
      console.error(
        `Error occurred while running ${interaction.commandName}: ${error}`
      );
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

    const redCaptain = game.getCaptainOfTeam("RED");
    const blueCaptain = game.getCaptainOfTeam("BLUE");

    const formatPlayers = (
      players: PlayerInstance[],
      captain: PlayerInstance | undefined
    ): string => {
      const formatName = (text: string | undefined): string =>
        text ? escapeText(text) : "Unknown Player";
      if (players.length === 0) return "No players";
      const sortedPlayers = captain
        ? [captain, ...players.filter((player) => player !== captain)]
        : players;
      return (
        `**${formatName(sortedPlayers[0].ignUsed)}**\n` +
        sortedPlayers
          .slice(1)
          .map((player) => formatName(player.ignUsed))
          .join("\n")
      );
    };

    const bluePlayersString = formatPlayers(bluePlayers, blueCaptain);
    const redPlayersString = formatPlayers(redPlayers, redCaptain);

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Teams")
      .addFields(
        {
          name: `🔵 Blue Team [${bluePlayers.length}] 🔵`,
          value: bluePlayersString,
          inline: true,
        },
        {
          name: `🔴 Red Team [${redPlayers.length}] 🔴`,
          value: redPlayersString,
          inline: true,
        }
      );

    return { embeds: [embed] };
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
            });
          }
          break;
        case "cancelled":
          this.resetTeamPickingSession();
          break;
      }
    }
  }

  public resetTeamPickingSession(): void {
    if (this.teamPickingSession?.cancelSession) {
      void this.teamPickingSession.cancelSession();
    }
    this.teamPickingSession = undefined;
  }

  public isTeamPickingSessionActive(): boolean {
    return this.teamPickingSession !== undefined;
  }
}
