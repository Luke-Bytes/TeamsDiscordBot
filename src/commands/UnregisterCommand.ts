import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface.js";
import { ConfigManager } from "../ConfigManager.js";
import { CurrentGameManager } from "../logic/CurrentGameManager.js";

export default class UnregisterCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "unregister";
  public description = "Unregister from the announced game!";
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addUserOption((option) =>
        option
          .setName("discorduser")
          .setDescription("The Discord user to unregister (organisers only)")
          .setRequired(false)
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = ConfigManager.getConfig();
    const registrationChannelId = config.channels.registration;
    const organiserRoleId = config.roles.organiserRole;

    if (interaction.channelId !== registrationChannelId) {
      await interaction.reply({
        content: "You can only unregister in the registration channel.",
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

    const targetUser =
      interaction.options.getUser("discorduser") || interaction.user;

    const discordUserId = targetUser.id;
    const discordUserName = targetUser.username;

    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const isOrganiser = member?.roles.cache.has(organiserRoleId);

    if (!isOrganiser && targetUser.id !== interaction.user.id) {
      await interaction.reply({
        content: "You do not have permission to unregister other users.",
        ephemeral: true,
      });
      return;
    }

    const isRegistered = CurrentGameManager.getCurrentGame()
      .getPlayers()
      .some((player) => player.discordSnowflake === discordUserId);

    if (!isRegistered) {
      await interaction.reply({
        content: `${discordUserName} is not registered for the announced game.`,
        ephemeral: false,
      });
      return;
    }

    const result =
      await CurrentGameManager.getCurrentGame().removePlayerByDiscordId(
        discordUserId
      );

    if (result.error) {
      await interaction.reply({
        content: result.error,
        ephemeral: false,
      });
    } else if (targetUser.id === interaction.user.id) {
      await interaction.reply({
        content: `You have successfully unregistered from the game!`,
        ephemeral: false,
      });
    } else {
      await interaction.reply({
        content: `${discordUserName} has been successfully unregistered.`,
        ephemeral: false,
      });
    }
  }
}
