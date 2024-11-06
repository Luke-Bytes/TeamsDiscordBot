import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface";
import { ConfigManager } from "../ConfigManager";
import { CurrentGameManager } from "../logic/CurrentGameManager";

export default class RegisterCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "register";
  public description = "Register for friendly war!";
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addStringOption((option) =>
        option
          .setName("ingamename")
          .setDescription("The in-game name to register")
          .setRequired(true)
      )
      .addUserOption((option) =>
        option
          .setName("discorduser")
          .setDescription("The Discord user to register (organisers only)")
          .setRequired(false)
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = ConfigManager.getConfig();
    const registrationChannelId = config.channels.registration;
    const organiserRoleId = config.roles.organiserRole;

    if (interaction.channelId !== registrationChannelId) {
      await interaction.reply({
        content: "You can only register in the registration channel.",
        ephemeral: true,
      });
      return;
    }

    if (!CurrentGameManager.getCurrentGame().announced) {
      await interaction.reply({
        content: "No game has been announced yet!",
        ephemeral: true,
      });
      return;
    }

    const inGameName = interaction.options.getString("ingamename", true);
    const targetUser =
      interaction.options.getUser("discorduser") || interaction.user;

    const discordUserId = targetUser.id;
    const discordUserName = targetUser.username;

    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const isOrganiser = member?.roles.cache.has(organiserRoleId);

    if (!isOrganiser && targetUser.id !== interaction.user.id) {
      await interaction.reply({
        content: "You do not have permission to register other users.",
        ephemeral: true,
      });
      return;
    }

    const isAlreadyRegistered = CurrentGameManager.getCurrentGame()
      .getPlayers()
      .some((player) => player.discordSnowflake === discordUserId);

    if (isAlreadyRegistered) {
      await interaction.reply({
        content:
          "You have already registered for the announced game!",
        ephemeral: false,
      });
      return;
    }

    const result =
      await CurrentGameManager.getCurrentGame().addPlayerByDiscordId(
        discordUserId,
        inGameName
      );

    if (result.error) {
      await interaction.reply({
        content: result.error,
        ephemeral: false,
      });
    } else {
      if (targetUser.id === interaction.user.id) {
        await interaction.reply({
          content: `You have successfully registered as ${inGameName} and joined team ${result.team}!`,
          ephemeral: false,
        });
      } else {
        await interaction.reply({
          content: `${discordUserName} has been successfully registered as ${inGameName} in team ${result.team}!`,
          ephemeral: false,
        });
      }
    }
  }
}
