import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  TextChannel,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { AnniClass } from "@prisma/client";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { prettifyName } from "../util/Utils.js";
import { DiscordUtil } from "../util/DiscordUtil";

export default class ClassbanCommand implements Command {
  public data = new SlashCommandBuilder()
    .setName("class")
    .setDescription("Captain class bans")
    .addSubcommand((sub) =>
      sub
        .setName("ban")
        .setDescription("Ban a class for this game (captains only)")
        .addStringOption((opt) =>
          opt
            .setName("class")
            .setDescription("Which class to ban")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("bans").setDescription("View all currently banned classes")
    );

  public name = "class";
  public description = this.data.description;
  public buttonIds: string[] = [];

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!CurrentGameManager.getCurrentGame().announced) {
      await interaction.reply({
        content: "No game is currently in progress",
        ephemeral: false,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();
    if (sub === "ban") {
      await this.handleBan(interaction);
    } else if (sub === "bans") {
      await this.handleView(interaction);
    }
  }

  private async handleBan(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: false });
    const game = CurrentGameManager.getCurrentGame();

    if (game.getTotalCaptainBans() >= game.getClassBanLimit()) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor("Grey")
            .setTitle("🚫 Class Bans Locked")
            .setDescription("All captain class bans have been used.")
            .setTimestamp(),
        ],
      });
    }

    const member = DiscordUtil.getGuildMember(interaction);
    if (!PermissionsUtil.hasRole(member, "captainRole")) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor("Red")
            .setTitle("🚫 Permission Denied")
            .setDescription("Only team captains may ban classes.")
            .setTimestamp(),
        ],
      });
    }

    if (game.hasCaptainReachedBanLimit(interaction.user.id)) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor("Yellow")
            .setTitle("⚠️ Already Used")
            .setDescription("You have used all your class ban(s).")
            .setTimestamp(),
        ],
      });
    }

    const raw = interaction.options
      .getString("class", true)
      .toUpperCase()
      .trim()
      .replace(/\s+/g, "");
    if (!Object.values(AnniClass).includes(raw as AnniClass)) {
      const channel = interaction.channel as TextChannel;
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor("Orange")
            .setTitle("❓ Unknown Class")
            .setDescription(
              `Class not recognised, spell it out fully, e.g. 'scout' instead of 'sco'.`
            )
            .setTimestamp(),
        ],
      });
      await interaction.deleteReply();
      return;
    }
    const cls = raw as AnniClass;

    const isNewBan = !game.settings.bannedClasses.includes(cls);
    if (isNewBan) {
      game.settings.bannedClasses.push(cls);
    }
    game.markCaptainHasBanned(interaction.user.id);

    const banEmbed = new EmbedBuilder()
      .setColor("Green")
      .setTitle("✅ Class Banned")
      .setDescription(`The ban has been recorded!`)
      .setFooter({ text: `Captain: ${interaction.user.tag}` })
      .setTimestamp();
    const channel = interaction.channel as TextChannel;
    await channel.send({ embeds: [banEmbed] });
    await interaction.deleteReply();

    if (game.getTotalCaptainBans() === game.getClassBanLimit()) {
      const list = game.settings.bannedClasses.map(prettifyName).join("\n");
      const lockedEmbed = new EmbedBuilder()
        .setColor("DarkRed")
        .setTitle("🚫 Class Bans Locked In")
        .setDescription(list)
        .setTimestamp();
      await DiscordUtil.sendMessage("gameFeed", { embeds: [lockedEmbed] });
      await DiscordUtil.sendMessage("redTeamChat", { embeds: [lockedEmbed] });
      await DiscordUtil.sendMessage("blueTeamChat", { embeds: [lockedEmbed] });
    }
  }

  private async handleView(interaction: ChatInputCommandInteraction) {
    const game = CurrentGameManager.getCurrentGame();

    if (game.getTotalCaptainBans() < game.getClassBanLimit()) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor("Grey")
            .setDescription(
              "Class bans are not available until both captains have used their ban."
            )
            .setTimestamp(),
        ],
        ephemeral: false,
      });
    }

    const banned = game.settings.bannedClasses;
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor("Blue")
          .setTitle("📋 Banned Classes")
          .setDescription(banned.map(prettifyName).join("\n"))
          .setTimestamp(),
      ],
      ephemeral: false,
    });
  }
}
