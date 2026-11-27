import {
  ActionRowBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { PrismaUtils } from "../util/PrismaUtils";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { Prisma } from "@prisma/client";
import { prismaClient } from "../database/prismaClient";

type ExpungeSession = {
  playerId: string;
  userId: string;
  createdAt: number;
  messageId: string;
  recordId: string;
  reasons: string[];
  punishmentDates: Date[];
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
  private async addPunishment(
    playerId: string, reason: string, currentDate: Date, expiryDate: Date
  ) {
    // Use the same per-player queue as final roster admission, without
    // holding a roster lock or delaying unrelated players.
    return PrismaUtils.withPunishmentAdmission(playerId, async () => {
      const existing = await prismaClient.playerPunishment.findFirst({
        where: { playerId },
      });
      if (existing) {
        const updated = await prismaClient.playerPunishment.update({
          where: { id: existing.id },
          data: {
            reasons: { push: reason },
            strikeCount: { increment: 1 },
            punishmentDates: { push: currentDate },
            punishmentExpiry: expiryDate,
          },
        });
        return { added: true, strikeCount: updated.strikeCount };
      }
      await prismaClient.playerPunishment.create({
        data: {
          playerId,
          reasons: [reason],
          strikeCount: 1,
          punishmentDates: [currentDate],
          punishmentExpiry: expiryDate,
        },
      });
      return { added: false, strikeCount: 1 };
    });
  }

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
      const expiryDate = this.computeExpiryDate(duration);

      if (!expiryDate) {
        await interaction.editReply(
          "Invalid duration. Use a number followed by `s`, `m`, `h`, or `d` (for example, use `7d` instead of `1w`)."
        );
        return;
      }

      const result = await this.addPunishment(player.id, reason, currentDate, expiryDate);
      if (result.added) {
        await interaction.editReply(
          `New punishment added for **${playerInput}**. Reason: "${reason}".` +
            ` Total strikes: ${result.strikeCount}.` +
            (expiryDate ? ` Expiry: ${expiryDate.toUTCString()}.` : "")
        );
      } else {
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

      const message = await interaction.editReply({
        content: `Select a punishment entry to expunge for **${playerInput}**.`,
        components: [row],
      });
      if (message?.id) {
        this.expungeSessions.set(interaction.user.id, {
          playerId: player.id,
          userId: interaction.user.id,
          createdAt: Date.now(),
          messageId: message.id,
          recordId: existing.id,
          reasons: [...existing.reasons],
          punishmentDates: [...existing.punishmentDates],
        });
      }
    }
  }

  async handleSelectMenu(
    interaction: StringSelectMenuInteraction
  ): Promise<void> {
    if (interaction.customId !== "punish-expunge-select") return;
    const session = this.expungeSessions.get(interaction.user.id);
    if (!session || session.userId !== interaction.user.id ||
        session.messageId !== interaction.message?.id) {
      await interaction.reply({
        content: "This expunge session has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!PermissionsUtil.hasRole(interaction.member as GuildMember, "organiserRole") || !interaction.guildId) {
      await interaction.reply({ content: "Only an authorised organiser may expunge punishments.", flags: MessageFlags.Ephemeral });
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
    if (!/^idx:\d+$/.test(choice) || !Number.isSafeInteger(idx)) {
      await interaction.reply({
        content: "Invalid selection.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Consume before any asynchronous DB access. A failed or ambiguous write
    // must not permit replay without a fresh review of the record.
    this.expungeSessions.delete(interaction.user.id);
    try {
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
      // The displayed index is only valid for the history shown in the menu.
      if (
        existing.id !== session.recordId ||
        existing.reasons.length !== session.reasons.length ||
        existing.reasons.some((reason, i) => reason !== session.reasons[i]) ||
        existing.punishmentDates.length !== session.punishmentDates.length ||
        existing.punishmentDates.some((date, i) =>
          date.getTime() !== session.punishmentDates[i].getTime())
      ) {
        await interaction.reply({
          content: "Punishment history changed. Open a new expunge menu.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Compare the complete relevant state at write time. An expiry cleanup
      // or concurrent add must not be overwritten by a stale expunge.
      const where: Prisma.PlayerPunishmentWhereUniqueInput = {
        id: existing.id,
        reasons: { equals: existing.reasons },
        punishmentDates: { equals: existing.punishmentDates },
        strikeCount: existing.strikeCount,
        ...(existing.punishmentExpiry == null
          ? { OR: [{ punishmentExpiry: null }, { punishmentExpiry: { isSet: false } }] }
          : { punishmentExpiry: existing.punishmentExpiry }),
      };

      const newReasons = existing.reasons.filter((_, i) => i !== idx);
      const newDates = existing.punishmentDates.filter((_, i) => i !== idx);
      const newStrikeCount = Math.max(0, newReasons.length);
      const removedLatest = idx === existing.reasons.length - 1;

      if (newReasons.length === 0) {
        await prismaClient.playerPunishment.delete({ where });
      } else {
        await prismaClient.playerPunishment.update({
          where,
          data: {
            reasons: newReasons,
            punishmentDates: newDates,
            strikeCount: newStrikeCount,
            punishmentExpiry: removedLatest ? null : existing.punishmentExpiry,
          },
        });
      }

      console.info("event=punish.expunge outcome=succeeded");
      await interaction.update({
        content: "Punishment entry removed.",
        components: [],
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "P2025") {
        await interaction.reply({
          content: "Punishment history or expiry changed. Open a new expunge menu.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      console.error(`event=punish.expunge outcome=failed error_type=${error instanceof Error ? error.name : "unknown"}`);
      await interaction.reply({
        content: "Expunge status is uncertain. Inspect the punishment record before submitting another request.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private computeExpiryDate(duration: string): Date | null {
    const durationMatch = /^(\d+)([smhd])$/.exec(duration.trim());
    if (!durationMatch) return null;

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
        return null;
    }

    return expiryDate;
  }
}
