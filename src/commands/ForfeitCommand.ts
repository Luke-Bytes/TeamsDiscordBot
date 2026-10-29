import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { DiscordUtil } from "../util/DiscordUtil";
import { Team } from "@prisma/client";
import { fetchGuildMember } from "../util/DiscordFailures";
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
    if (!game?.announced || game.getGameStartStatus() !== "started" ||
        game.isFinished || game.isRestarting) {
      await interaction.reply({
        content: "No game is currently in progress.",
      });
      return;
    }

    const member = DiscordUtil.getGuildMember(interaction);
    if (!PermissionsUtil.hasRole(member, "captainRole")) {
      await interaction.reply({
        content: "Only team captains can forfeit!",
      });
      return;
    }

    const isBlue = PermissionsUtil.hasRole(member, "blueTeamRole");
    const isRed = PermissionsUtil.hasRole(member, "redTeamRole");
    if (!isBlue && !isRed) {
      await interaction.reply({
        content: "You are not on Blue or Red team.",
      });
      return;
    }

    const team = isBlue ? Team.BLUE : Team.RED;
    if (game.getCaptainOfTeam(team)?.discordSnowflake !== interaction.user.id) {
      await interaction.reply({ content: "Only the current game captain may forfeit for this team." });
      return;
    }
    const opponent = team === Team.BLUE ? Team.RED : Team.BLUE;
    const token = game.getLifecycleToken();

    const embed = new EmbedBuilder()
      .setColor(isBlue ? "Blue" : "Red")
      .setTitle("Confirm Forfeit")
      .setDescription(
        `${isBlue ? "🔵 Blue" : "🔴 Red"} captain **${interaction.user.tag}** — are you sure you want to forfeit? The win will automatically go to **${opponent === Team.BLUE ? "Blue" : "Red"} Team**.`
      )
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`forfeit_confirm:${token}`)
        .setLabel("Confirm Forfeit")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`forfeit_cancel:${token}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      embeds: [embed],
      components: [row],
    });
  }

  public async handleButtonPress(
    interaction: ButtonInteraction
  ): Promise<void> {
    const id = interaction.customId;
    const game = CurrentGameManager.getCurrentGame();
    const match = /^forfeit_(confirm|cancel):([a-f0-9-]{36})$/.exec(id);
    if (!match || match[2] !== game.getLifecycleToken() ||
        !game.announced || game.getGameStartStatus() !== "started" ||
        game.isFinished || game.isRestarting) {
      await interaction.reply({
        content: "This forfeit confirmation has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const originalInvokerId = interaction.message.interaction?.user.id;
    if (!originalInvokerId || originalInvokerId !== interaction.user.id) {
      await interaction.reply({
        content: "Only the captain who initiated this can confirm/cancel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (match[1] === "cancel") {
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
    if (match[1] !== "confirm") return;

    await interaction.deferUpdate();

    if (!game.announced || match[2] !== game.getLifecycleToken() ||
        game.getGameStartStatus() !== "started" || game.isFinished || game.isRestarting) {
      await interaction.editReply({
        content: "No game is currently in progress.",
        embeds: [],
        components: [],
      });
      return;
    }

    let member;
    try {
      if (!interaction.guild) throw new Error("No guild for forfeit confirmation");
      member = await fetchGuildMember(interaction.guild, interaction.user.id);
    } catch (error) {
      console.error("Forfeit captain verification failed", error);
      await interaction.editReply({ content: "Cannot verify captain membership with Discord right now.", embeds: [], components: [] });
      return;
    }
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
    if (game.getCaptainOfTeam(forfeitingTeam)?.discordSnowflake !== interaction.user.id) {
      await interaction.editReply({ content: "You are no longer the current captain of this team.", embeds: [], components: [] });
      return;
    }
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
