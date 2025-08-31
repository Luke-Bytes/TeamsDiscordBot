import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  TextChannel,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { AnniClass, Team } from "@prisma/client";
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
      await interaction.reply({ content: "No game is currently in progress" });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === "ban") await this.handleBan(interaction);
    else if (sub === "bans") await this.handleView(interaction);
  }

  private async handleBan(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    const game = CurrentGameManager.getCurrentGame();

    if (game.getClassBanLimit() === 0) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor("Grey")
            .setTitle("🚫 Class Bans Disabled")
            .setDescription("No class bans are allowed for this game.")
            .setTimestamp(),
        ],
      });
    }

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
    if (game.isCaptainBanLocked(interaction.user.id)) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor("Grey")
            .setTitle("⏰ Class Ban Window Closed")
            .setDescription("Your team can no longer ban a class.")
            .setTimestamp(),
        ],
      });
    }
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
    const mode = game.classBanMode;
    const team = PermissionsUtil.hasRole(member, "blueTeamRole")
      ? Team.BLUE
      : Team.RED;
    const opponent = team === Team.BLUE ? Team.RED : Team.BLUE;

    const banned = game.settings.bannedClasses;
    const byTeam = game.settings.bannedClassesByTeam;

    if (mode === "shared") {
      if (!banned.includes(cls)) banned.push(cls);
    } else if (mode === "opponentOnly") {
      const forbidden: AnniClass[] = [
        AnniClass.ENCHANTER,
        AnniClass.DASHER,
        AnniClass.FARMER,
        AnniClass.MINER,
        AnniClass.RIFTWALKER,
        AnniClass.TRANSPORTER,
      ];
      if (forbidden.includes(cls)) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor("Orange")
              .setTitle("🚫 Cannot Ban Core Class")
              .setDescription(
                `${prettifyName(cls)} may not be banned.\n\n**Core Classes:**\n${forbidden
                  .map(prettifyName)
                  .join("\n")}`
              )
              .setTimestamp(),
          ],
        });
      }
      if (!byTeam[opponent].includes(cls)) byTeam[opponent].push(cls);
    } else if (!byTeam[team].includes(cls)) byTeam[team].push(cls);

    game.markCaptainHasBanned(interaction.user.id);

    const captainLabel = team === Team.BLUE ? "Blue Captain" : "Red Captain";
    const banEmbed = new EmbedBuilder()
      .setColor("Green")
      .setTitle("✅ Class Banned")
      .setDescription("The ban has been recorded!")
      .setFooter({ text: `${captainLabel}: ${interaction.user.tag}` })
      .setTimestamp();
    const channel = interaction.channel as TextChannel;
    await channel.send({ embeds: [banEmbed] });
    await interaction.deleteReply();

    if (
      game.getTotalCaptainBans() === game.getClassBanLimit() &&
      !game.areClassBansAnnounced()
    ) {
      const byTeam = game.settings.bannedClassesByTeam;
      const banned = game.settings.bannedClasses;
      const both = banned.filter(
        (c) => !byTeam[Team.RED].includes(c) && !byTeam[Team.BLUE].includes(c)
      );
      const redOnly = byTeam[Team.RED].filter((c) => !both.includes(c));
      const blueOnly = byTeam[Team.BLUE].filter((c) => !both.includes(c));

      const lockedEmbed = new EmbedBuilder()
        .setColor("DarkRed")
        .setTitle("🚫 Class Bans Locked In")
        .addFields(
          {
            name: "⚫ Shared Bans",
            value: both.length ? both.map(prettifyName).join("\n") : "None",
            inline: true,
          },
          {
            name: "🔴 Red Can't Use",
            value: redOnly.length
              ? redOnly.map(prettifyName).join("\n")
              : "None",
            inline: true,
          },
          {
            name: "🔵 Blue Can't Use",
            value: blueOnly.length
              ? blueOnly.map(prettifyName).join("\n")
              : "None",
            inline: true,
          }
        )
        .setTimestamp();

      await DiscordUtil.sendMessage("gameFeed", { embeds: [lockedEmbed] });
      await DiscordUtil.sendMessage("redTeamChat", { embeds: [lockedEmbed] });
      await DiscordUtil.sendMessage("blueTeamChat", { embeds: [lockedEmbed] });
      game.markClassBansAnnounced();
    }
  }

  private async handleView(interaction: ChatInputCommandInteraction) {
    const game = CurrentGameManager.getCurrentGame();

    if (game.getClassBanLimit() === 0) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor("Grey")
            .setDescription("Class bans are disabled for this game.")
            .setTimestamp(),
        ],
      });
    }

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
    });
  }
}
