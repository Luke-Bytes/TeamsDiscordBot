import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface.js";
import { PrismaClient } from "@prisma/client";
import { PrismaUtils } from "../util/PrismaUtils";
import { PermissionsUtil } from "../util/PermissionsUtil";

const prisma = new PrismaClient();

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
    );

  name = "punish";
  description = "Punish a player and log it to the database";
  buttonIds = [];

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    const member = interaction.guild?.members.cache.get(interaction.user.id);
    if (!PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.editReply(
        "You do not have permission to manage punishments."
      );
      return;
    }

    const subcommand = interaction.options.getSubcommand();
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

      const existing = await prisma.playerPunishment.findFirst({
        where: { playerId: player.id },
      });

      if (existing) {
        await prisma.playerPunishment.update({
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
        await prisma.playerPunishment.create({
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
      const existing = await prisma.playerPunishment.findFirst({
        where: { playerId: player.id },
      });

      if (!existing) {
        await interaction.editReply(
          `No punishment found for **${playerInput}**.`
        );
        return;
      }

      await prisma.playerPunishment.update({
        where: { id: existing.id },
        data: { punishmentExpiry: null },
      });

      await interaction.editReply(
        `Punishment for **${playerInput}** has been removed.`
      );
    }
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
