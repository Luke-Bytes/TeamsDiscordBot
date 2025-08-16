import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { DiscordUtil } from "../util/DiscordUtil";
import { Team } from "@prisma/client";
export default class ForfeitCommand implements Command {
  public data = new SlashCommandBuilder()
    .setName("forfeit")
    .setDescription("Forfeit the match for your team");
  public name = "forfeit";
  public description = this.data.description;
  public buttonIds = ["forfeit_confirm", "forfeit_cancel"];

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const game = CurrentGameManager.getCurrentGame();
    if (!game?.announced) {
      await interaction.reply({
        content: "No game is currently in progress.",
        ephemeral: false,
      });
      return;
    }

    const member = DiscordUtil.getGuildMember(interaction);
    if (!PermissionsUtil.hasRole(member, "captainRole")) {
      await interaction.reply({
        content: "Only team captains can forfeit!",
        ephemeral: false,
      });
      return;
    }

    const isBlue = PermissionsUtil.hasRole(member, "blueTeamRole");
    const isRed = PermissionsUtil.hasRole(member, "redTeamRole");
    if (!isBlue && !isRed) {
      await interaction.reply({
        content: "You are not on Blue or Red team.",
        ephemeral: false,
      });
      return;
    }

    const team = isBlue ? Team.BLUE : Team.RED;
    const opponent = team === Team.BLUE ? Team.RED : Team.BLUE;

    const embed = new EmbedBuilder()
      .setColor(isBlue ? "Blue" : "Red")
      .setTitle("Confirm Forfeit")
      .setDescription(
        `${isBlue ? "🔵 Blue" : "🔴 Red"} captain **${interaction.user.tag}** — are you sure you want to forfeit? The win will automatically go to **${opponent === Team.BLUE ? "Blue" : "Red"} Team**.`
      )
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("forfeit_confirm")
        .setLabel("Confirm Forfeit")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("forfeit_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      embeds: [embed],
      components: [row],
      ephemeral: false,
    });
  }

  public async handleButtonPress(
    interaction: ButtonInteraction
  ): Promise<void> {
    const id = interaction.customId;

    const originalInvokerId = interaction.message.interaction?.user.id;
    if (!originalInvokerId || originalInvokerId !== interaction.user.id) {
      await interaction.reply({
        content: "Only the captain who initiated this can confirm/cancel.",
        ephemeral: true,
      });
      return;
    }

    if (id === "forfeit_cancel") {
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("forfeit_confirm")
          .setLabel("Confirm Forfeit")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("forfeit_cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
      );
      await interaction.update({
        content: "Forfeit cancelled.",
        embeds: [],
        components: [disabledRow],
      });
      return;
    }
    if (id !== "forfeit_confirm") return;

    await interaction.deferUpdate();

    const game = CurrentGameManager.getCurrentGame();
    if (!game?.announced) {
      await interaction.editReply({
        content: "No game is currently in progress.",
        embeds: [],
        components: [],
      });
      return;
    }

    // Recompute current roles at click time
    const member = await interaction
      .guild!.members.fetch(interaction.user.id)
      .catch(() => null);
    if (!member || !PermissionsUtil.hasRole(member, "captainRole")) {
      await interaction.editReply({
        content: "Only team captains can forfeit!",
        embeds: [],
        components: [],
      });
      return;
    }

    const isBlue = PermissionsUtil.hasRole(member, "blueTeamRole");
    const isRed = PermissionsUtil.hasRole(member, "redTeamRole");
    if (!isBlue && !isRed) {
      await interaction.editReply({
        content: "You are not on Blue or Red team.",
        embeds: [],
        components: [],
      });
      return;
    }

    const forfeitingTeam = isBlue ? Team.BLUE : Team.RED;
    const winnerTeam = forfeitingTeam === Team.BLUE ? Team.RED : Team.BLUE;

    try {
      await game.setGameWinner(winnerTeam);
    } catch (e) {
      console.error("Failed to set game winner from forfeit:", e);
      await interaction.editReply({
        content: "Failed to set winner. Try again or use /winner set.",
        embeds: [],
        components: [],
      });
      return;
    }

    const resultEmbed = new EmbedBuilder()
      .setColor(isBlue ? "Blue" : "Red")
      .setTitle(isBlue ? "🔵 Blue Forfeit" : "🔴 Red Forfeit")
      .setDescription(
        `${isBlue ? "Blue" : "Red"} have forfeited. **${winnerTeam === Team.BLUE ? "Blue" : "Red"}** will be awarded the win.`
      )
      .setFooter({ text: `Confirmed by ${interaction.user.tag}` })
      .setTimestamp();

    await DiscordUtil.sendMessage("gameFeed", { embeds: [resultEmbed] });
    await DiscordUtil.sendMessage("redTeamChat", { embeds: [resultEmbed] });
    await DiscordUtil.sendMessage("blueTeamChat", { embeds: [resultEmbed] });

    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("forfeit_confirm")
        .setLabel("Confirm Forfeit")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId("forfeit_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    );

    await interaction.editReply({
      content: "Forfeit confirmed.",
      embeds: [],
      components: [disabledRow],
    });
  }
}
