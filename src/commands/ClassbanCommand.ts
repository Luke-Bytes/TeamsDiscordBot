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
import { readFileSync } from "fs";
import path from "path";

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

    const organiserBans = game.settings.organiserBannedClasses ?? [];
    const sharedCaptainBans = game.settings.sharedCaptainBannedClasses;
    const byTeam = game.settings.nonSharedCaptainBannedClasses ?? {
      [Team.RED]: [],
      [Team.BLUE]: [],
    };
    game.settings.nonSharedCaptainBannedClasses = byTeam;

    if (organiserBans.includes(cls)) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor("Yellow")
            .setTitle("⚠️ Already Banned")
            .setDescription(
              `${prettifyName(cls)} is already banned by the organiser. Please choose a different class so your ban isn't wasted.`
            )
            .setTimestamp(),
        ],
      });
    }

    if (mode === "shared") {
      if (!sharedCaptainBans.includes(cls)) sharedCaptainBans.push(cls);
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
    } else if (!byTeam[team].includes(cls)) {
      byTeam[team].push(cls);
    }

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
      const byTeam = game.settings.nonSharedCaptainBannedClasses ?? {
        [Team.RED]: [],
        [Team.BLUE]: [],
      };
      game.settings.nonSharedCaptainBannedClasses = byTeam;
      const organiserBans = game.settings.organiserBannedClasses;
      const sharedCaptainBans = game.settings.sharedCaptainBannedClasses;
      let both: string[];
      let redOnly: string[];
      let blueOnly: string[];

      if (game.classBanMode === "shared") {
        // In shared mode, ALL bans are presented as shared
        const sharedSet = new Set([
          ...organiserBans,
          ...sharedCaptainBans,
          ...byTeam[Team.RED],
          ...byTeam[Team.BLUE],
        ]);
        both = Array.from(sharedSet);
        redOnly = [];
        blueOnly = [];
      } else {
        const sharedSet = new Set([...organiserBans, ...sharedCaptainBans]);
        both = Array.from(sharedSet);
        redOnly = byTeam[Team.RED].filter((c) => !sharedSet.has(c));
        blueOnly = byTeam[Team.BLUE].filter((c) => !sharedSet.has(c));
      }

      if (game.settings.delayedBan > 0) {
        const dmOk = await this.notifyHostDelayedBans(
          interaction,
          both,
          game.settings.delayedBan
        );
        if (dmOk) {
          const delayedEmbed = this.buildDelayedBanEmbed(
            both.length,
            game.settings.delayedBan
          );
          await DiscordUtil.sendMessage("gameFeed", { embeds: [delayedEmbed] });
          await DiscordUtil.sendMessage("redTeamChat", {
            embeds: [delayedEmbed],
          });
          await DiscordUtil.sendMessage("blueTeamChat", {
            embeds: [delayedEmbed],
          });
        } else {
          const lockedEmbed = this.buildLockedBansEmbed(
            both,
            redOnly,
            blueOnly
          );
          await DiscordUtil.sendMessage("gameFeed", { embeds: [lockedEmbed] });
          await DiscordUtil.sendMessage("redTeamChat", {
            embeds: [lockedEmbed],
          });
          await DiscordUtil.sendMessage("blueTeamChat", {
            embeds: [lockedEmbed],
          });
        }
      } else {
        const lockedEmbed = this.buildLockedBansEmbed(both, redOnly, blueOnly);
        await DiscordUtil.sendMessage("gameFeed", { embeds: [lockedEmbed] });
        await DiscordUtil.sendMessage("redTeamChat", { embeds: [lockedEmbed] });
        await DiscordUtil.sendMessage("blueTeamChat", {
          embeds: [lockedEmbed],
        });
      }
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

    if (game.settings.delayedBan > 0) {
      const byTeam = game.settings.nonSharedCaptainBannedClasses ?? {
        [Team.RED]: [],
        [Team.BLUE]: [],
      };
      game.settings.nonSharedCaptainBannedClasses = byTeam;
      const organiserBans = game.settings.organiserBannedClasses;
      const sharedCaptainBans = game.settings.sharedCaptainBannedClasses;
      const sharedSet = new Set([
        ...organiserBans,
        ...sharedCaptainBans,
        ...byTeam[Team.RED],
        ...byTeam[Team.BLUE],
      ]);
      return interaction.reply({
        embeds: [
          this.buildDelayedBanEmbed(sharedSet.size, game.settings.delayedBan),
        ],
      });
    }

    const byTeam = game.settings.nonSharedCaptainBannedClasses ?? {
      [Team.RED]: [],
      [Team.BLUE]: [],
    };
    game.settings.nonSharedCaptainBannedClasses = byTeam;
    const organiserBans = game.settings.organiserBannedClasses;
    const sharedCaptainBans = game.settings.sharedCaptainBannedClasses;

    const sharedSet =
      game.classBanMode === "shared"
        ? new Set([
            ...organiserBans,
            ...sharedCaptainBans,
            ...byTeam[Team.RED],
            ...byTeam[Team.BLUE],
          ])
        : new Set([...organiserBans, ...sharedCaptainBans]);

    const both = Array.from(sharedSet);
    const redOnly =
      game.classBanMode === "shared"
        ? []
        : byTeam[Team.RED].filter((c) => !sharedSet.has(c));
    const blueOnly =
      game.classBanMode === "shared"
        ? []
        : byTeam[Team.BLUE].filter((c) => !sharedSet.has(c));

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor("Blue")
          .setTitle("📋 Banned Classes")
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
          .setTimestamp(),
      ],
    });
  }

  private buildDelayedBanEmbed(count: number, phase: number) {
    return new EmbedBuilder()
      .setColor("DarkPurple")
      .setTitle("⏳ Delayed Class Bans")
      .setDescription(
        `**${count}** ban${count === 1 ? "" : "s"} will become active at **Phase ${phase}**.`
      )
      .setTimestamp();
  }

  private loadHostDiscordId(hostIgn?: string | null): string | null {
    if (!hostIgn) return null;
    const namesPath = path.resolve(process.cwd(), "organisers-hosts.json");
    try {
      const raw = readFileSync(namesPath, "utf8");
      const parsed = JSON.parse(raw) as {
        hosts?: Array<{ ign: string; discordId?: string }>;
      };
      const hostEntry = parsed.hosts?.find(
        (entry) => entry.ign.toLowerCase() === hostIgn.toLowerCase()
      );
      return hostEntry?.discordId ?? null;
    } catch {
      return null;
    }
  }

  private async notifyHostDelayedBans(
    interaction: ChatInputCommandInteraction,
    bans: string[],
    phase: number
  ): Promise<boolean> {
    const hostIgn = CurrentGameManager.getCurrentGame().host;
    const hostId = this.loadHostDiscordId(hostIgn);
    if (!hostId) {
      console.warn(
        `[ClassbanCommand] No host discord ID found for ${hostIgn ?? "unknown"}`
      );
      return false;
    }
    try {
      const user = await interaction.client.users.fetch(hostId);
      const embed = new EmbedBuilder()
        .setColor("DarkPurple")
        .setTitle("⏳ Delayed Class Bans (For Host's Eyes Only!)")
        .setDescription(
          `These bans are secret until **Phase ${phase}**. Please ban them only then! Thank you`
        )
        .addFields({
          name: "Bans",
          value: bans.length ? bans.map(prettifyName).join("\n") : "None",
        })
        .setTimestamp();
      await user.send({ embeds: [embed] });
      return true;
    } catch (error) {
      console.error(
        `[ClassbanCommand] Failed to DM host ${hostId} about delayed bans:`,
        error
      );
      return false;
    }
  }

  private buildLockedBansEmbed(
    both: string[],
    redOnly: string[],
    blueOnly: string[]
  ) {
    return new EmbedBuilder()
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
          value: redOnly.length ? redOnly.map(prettifyName).join("\n") : "None",
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
  }
}
