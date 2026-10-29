import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ButtonInteraction,
} from "discord.js";
import { Command } from "./CommandInterface";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { DiscordUtil } from "../util/DiscordUtil";
import { escapeIgn } from "../util/Utils";

export default class WinnerCommand implements Command {
  name = "winner";
  description = "Sets the winning team.";
  buttonIds = ["winner_confirm_yes", "winner_confirm_no"];
  private pendingConfirmations = new Map<
    string,
    { userId: string; team: "RED" | "BLUE"; lifecycleToken: string }
  >();

  data = new SlashCommandBuilder()
    .setName("winner")
    .setDescription("Manage game winner")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set the game winner")
        .addStringOption((option) =>
          option
            .setName("team")
            .setDescription("The winning team")
            .setRequired(true)
            .addChoices(
              { name: "BLUE", value: "BLUE" },
              { name: "RED", value: "RED" }
            )
        )
    );

  async execute(interaction: ChatInputCommandInteraction) {
    const isAuthorized = await PermissionsUtil.isUserAuthorised(interaction);
    if (!isAuthorized) return;

    const team = interaction.options.getString("team", true).toUpperCase();

    if (team !== "BLUE" && team !== "RED") {
      await interaction.reply({
        content: "Invalid team selected. Choose either BLUE or RED.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const game = CurrentGameManager.getCurrentGame();
      if (!game.announced || game.isRestarting) {
        await interaction.reply({ content: "No active game can accept a winner right now.", flags: MessageFlags.Ephemeral });
        return;
      }
      const redCaptain = game.getCaptainOfTeam("RED");
      const blueCaptain = game.getCaptainOfTeam("BLUE");
      const redPlayers = game.getPlayersOfTeam("RED").slice(0, 3);
      const bluePlayers = game.getPlayersOfTeam("BLUE").slice(0, 3);

      const embed = new EmbedBuilder()
        .setTitle("Confirm Winner")
        .setDescription(`You are about to set **${team}** as the winner.`)
        .setColor(team === "RED" ? 0xe74c3c : 0x3498db)
        .addFields(
          {
            name: "🔴 Red Captain",
            value: redCaptain
              ? escapeIgn(redCaptain.ignUsed ?? "Unknown Player")
              : "None",
            inline: true,
          },
          {
            name: "🔵 Blue Captain",
            value: blueCaptain
              ? escapeIgn(blueCaptain.ignUsed ?? "Unknown Player")
              : "None",
            inline: true,
          },
          {
            name: "🔴 Red Players (first 3)",
            value: redPlayers.length
              ? redPlayers
                  .map((p) => escapeIgn(p.ignUsed ?? "Unknown Player"))
                  .join("\n")
              : "None",
            inline: true,
          },
          {
            name: "🔵 Blue Players (first 3)",
            value: bluePlayers.length
              ? bluePlayers
                  .map((p) => escapeIgn(p.ignUsed ?? "Unknown Player"))
                  .join("\n")
              : "None",
            inline: true,
          }
        );

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("winner_confirm_yes")
          .setLabel("Yes, set winner")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("winner_confirm_no")
          .setLabel("No, cancel")
          .setStyle(ButtonStyle.Danger)
      );

      const message = await DiscordUtil.replyWithMessage(interaction, {
        embeds: [embed],
        components: [row],
      });
      if (!message) {
        console.error("Failed to capture winner confirmation message.");
        return;
      }
      this.pendingConfirmations.set(message.id, {
        userId: interaction.user.id,
        team: team as "RED" | "BLUE",
        lifecycleToken: game.getLifecycleToken(),
      });
    } catch (error) {
      console.error("Failed to set game winner: ", error);
      await interaction.reply({
        content: "An error occurred while setting the winner.",
      });
    }
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    const pending = this.pendingConfirmations.get(interaction.message.id);
    if (!pending) {
      await interaction.reply({
        content: "This confirmation has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.user.id !== pending.userId) {
      await interaction.reply({
        content: "Only the user who requested this can confirm.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const game = CurrentGameManager.getCurrentGame();
    if (game.getLifecycleToken() !== pending.lifecycleToken ||
        !game.announced || game.isRestarting) {
      this.pendingConfirmations.delete(interaction.message.id);
      await interaction.reply({
        content: "This winner confirmation has expired or the game is shutting down.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Consume confirmation before awaiting: two rapid button presses cannot
    // both mutate game state, even if Discord's response subsequently expires.
    this.pendingConfirmations.delete(interaction.message.id);
    if (interaction.customId === "winner_confirm_no") {
      await interaction.update({
        content: "Winner set cancelled.",
        embeds: [],
        components: [],
      });
      return;
    }

    try {
      await game.setGameWinner(pending.team);
    } catch (error) {
      console.error("Failed to set game winner:", error);
      await interaction.update({
        content: "An error occurred while setting the winner.",
        embeds: [],
        components: [],
      });
      return;
    }
    try {
      await interaction.update({
        content: `The winning team has been set to **${pending.team}**!`,
        embeds: [],
        components: [],
      });
    } catch (error) {
      console.warn("Winner was set, but confirmation response failed; do not retry blindly", error);
    }
  }
}
