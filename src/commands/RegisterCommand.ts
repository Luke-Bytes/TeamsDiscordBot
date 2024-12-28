import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface.js";
import { PermissionsUtil } from "../util/PermissionsUtil.js";
import { CurrentGameManager } from "../logic/CurrentGameManager.js";

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
    if (!PermissionsUtil.isChannel(interaction, "registration")) {
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

    interaction.deferReply({});

    if (
      !PermissionsUtil.hasRole(member, "organiserRole") &&
      !PermissionsUtil.isSameUser(interaction, targetUser.id)
    ) {
      await interaction.editReply({
        content: "You do not have permission to register other users.",
      });
      return;
    }

    const isAlreadyRegistered = CurrentGameManager.getCurrentGame()
      .getPlayers()
      .some((player) => player.discordSnowflake === discordUserId);

    if (isAlreadyRegistered) {
      await interaction.editReply({
        content: "You have already registered for the announced game!",
      });
      return;
    }

    const result =
      await CurrentGameManager.getCurrentGame().addPlayerByDiscordId(
        discordUserId,
        inGameName
      );

    if (result.error) {
      await interaction.editReply({
        content: result.error,
      });
    } else if (PermissionsUtil.isSameUser(interaction, targetUser.id)) {
      await interaction.editReply({
        content: `You have successfully registered as ${inGameName}!`,
      });
    } else {
      await interaction.editReply({
        content: `${discordUserName} has been successfully registered as ${inGameName}`,
      });
    }
  }
}
