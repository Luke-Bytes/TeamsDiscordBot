import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { PrismaUtils } from "../util/PrismaUtils";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { prismaClient } from "../database/prismaClient";

type ExpungeSession = {
  playerId: string;
  userId: string;
  createdAt: number;
};

export default class PunishCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("punish")
    .setDescription("Manage player punishments")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add a punishment")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription("Player name or Discord user")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Reason for punishment")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("duration")
            .setDescription("Duration of the punishment (e.g '1d', '2h')")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a punishment")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription("Player name or Discord user")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("expunge")
        .setDescription("Remove a specific punishment entry")
        .addStringOption((option) =>
          option
            .setName("player")
            .setDescription("Player name or Discord user")
            .setRequired(true)
        )
    );

  name = "punish";
  description = "Punish a player and log it to the database";
  buttonIds = [];
  selectMenuIds = ["punish-expunge-select"];
  private readonly expungeSessions = new Map<string, ExpungeSession>();

  async execute(interaction: ChatInputCommandInteraction) {
    const member = interaction.guild?.members.cache.get(interaction.user.id);
    if (!PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(
        "You do not have permission to manage punishments."
      );
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "expunge") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferReply();
    }
    const playerInput = interaction.options.getString("player", true);
    const player = await PrismaUtils.findPlayer(playerInput);
    if (!player) {
      await interaction.editReply(`Player "${playerInput}" not found.`);
      return;
    }

    if (subcommand === "add") {
      const reason = interaction.options.getString("reason", true);
      const duration = interaction.options.getString("duration", true);
      const currentDate = new Date();
      const expiryDate = duration ? this.computeExpiryDate(duration) : null;

      const existing = await prismaClient.playerPunishment.findFirst({
        where: { playerId: player.id },
      });

      if (existing) {
        await prismaClient.playerPunishment.update({
          where: { id: existing.id },
          data: {
            reasons: [...existing.reasons, reason],
            strikeCount: existing.strikeCount + 1,
            punishmentDates: [...existing.punishmentDates, currentDate],
            punishmentExpiry: expiryDate || existing.punishmentExpiry,
          },
        });

        await interaction.editReply(
          `New punishment added for **${playerInput}**. Reason: "${reason}".` +
            ` Total strikes: ${existing.strikeCount + 1}.` +
            (expiryDate ? ` Expiry: ${expiryDate.toUTCString()}.` : "")
        );
      } else {
        await prismaClient.playerPunishment.create({
          data: {
            playerId: player.id,
            reasons: [reason],
            strikeCount: 1,
            punishmentDates: [currentDate],
            punishmentExpiry: expiryDate,
          },
        });

        await interaction.editReply(
          `Punished **${playerInput}** for reason: "${reason}".` +
            (expiryDate ? ` Expires on ${expiryDate.toUTCString()}.` : "")
        );
      }
    } else if (subcommand === "remove") {
      const existing = await prismaClient.playerPunishment.findFirst({
        where: { playerId: player.id },
      });

      if (!existing) {
        await interaction.editReply(
          `No punishment found for **${playerInput}**.`
        );
        return;
      }

      await prismaClient.playerPunishment.update({
        where: { id: existing.id },
        data: { punishmentExpiry: null },
      });

      await interaction.editReply(
        `Punishment for **${playerInput}** has been removed.`
      );
    } else if (subcommand === "expunge") {
      const existing = await prismaClient.playerPunishment.findFirst({
        where: { playerId: player.id },
      });

      if (!existing || existing.reasons.length === 0) {
        await interaction.editReply(
          `No punishment history found for **${playerInput}**.`
        );
        return;
      }

      const maxItems = 24;
      const entries = existing.reasons
        .map((reason, idx) => ({
          idx,
          reason,
          date: existing.punishmentDates[idx],
        }))
        .slice(0, maxItems);

      const options = entries.map((entry) => ({
        label: `${entry.idx + 1}. ${entry.reason}`.slice(0, 100),
        description: entry.date
          ? new Date(entry.date).toLocaleString()
          : "Unknown date",
        value: `idx:${entry.idx}`,
      }));

      options.push({
        label: "Cancel",
        description: "Do not remove any punishments",
        value: "cancel",
      });

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("punish-expunge-select")
          .setPlaceholder("Select a punishment to remove")
          .addOptions(options)
          .setMinValues(1)
          .setMaxValues(1)
      );

      this.expungeSessions.set(interaction.user.id, {
        playerId: player.id,
        userId: interaction.user.id,
        createdAt: Date.now(),
      });

      await interaction.editReply({
        content: `Select a punishment entry to expunge for **${playerInput}**.`,
        components: [row],
      });
    }
  }

  async handleSelectMenu(
    interaction: StringSelectMenuInteraction
  ): Promise<void> {
    if (interaction.customId !== "punish-expunge-select") return;
    const session = this.expungeSessions.get(interaction.user.id);
    if (!session || session.userId !== interaction.user.id) {
      await interaction.reply({
        content: "This expunge session has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const ttlMs = 5 * 60 * 1000;
    if (Date.now() - session.createdAt > ttlMs) {
      this.expungeSessions.delete(interaction.user.id);
      await interaction.reply({
        content: "This expunge session has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const choice = interaction.values[0];
    if (choice === "cancel") {
      this.expungeSessions.delete(interaction.user.id);
      await interaction.update({
        content: "Expunge canceled.",
        components: [],
      });
      return;
    }

    const idx = Number(choice.replace("idx:", ""));
    if (!Number.isFinite(idx)) {
      await interaction.reply({
        content: "Invalid selection.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const existing = await prismaClient.playerPunishment.findFirst({
      where: { playerId: session.playerId },
    });

    if (!existing || !existing.reasons[idx]) {
      await interaction.reply({
        content: "Punishment entry not found.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const newReasons = existing.reasons.filter((_, i) => i !== idx);
    const newDates = existing.punishmentDates.filter((_, i) => i !== idx);
    const newStrikeCount = Math.max(0, newReasons.length);
    const removedLatest = idx === existing.reasons.length - 1;

    if (newReasons.length === 0) {
      await prismaClient.playerPunishment.delete({
        where: { id: existing.id },
      });
    } else {
      await prismaClient.playerPunishment.update({
        where: { id: existing.id },
        data: {
          reasons: newReasons,
          punishmentDates: newDates,
          strikeCount: newStrikeCount,
          punishmentExpiry: removedLatest ? null : existing.punishmentExpiry,
        },
      });
    }

    this.expungeSessions.delete(interaction.user.id);
    await interaction.update({
      content: "Punishment entry removed.",
      components: [],
    });
  }

  private computeExpiryDate(duration: string): Date {
    const durationMatch = RegExp(/(\d+)([smhd])/).exec(duration);
    if (!durationMatch) throw new Error("Invalid duration format");

    const value = parseInt(durationMatch[1]);
    const unit = durationMatch[2];
    const expiryDate = new Date();

    switch (unit) {
      case "s":
        expiryDate.setSeconds(expiryDate.getSeconds() + value);
        break;
      case "m":
        expiryDate.setMinutes(expiryDate.getMinutes() + value);
        break;
      case "h":
        expiryDate.setHours(expiryDate.getHours() + value);
        break;
      case "d":
        expiryDate.setDate(expiryDate.getDate() + value);
        break;
      default:
        throw new Error("Invalid duration unit");
    }

    return expiryDate;
  }
}
