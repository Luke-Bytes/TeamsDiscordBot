import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface.js";
import { PrismaClient } from "@prisma/client";
import { PrismaUtils } from "../util/PrismaUtils";

const prisma = new PrismaClient();

export default class PunishedCommand implements Command {
  data = new SlashCommandBuilder()
    .setName("punished")
    .setDescription("View punishment records")
    .addStringOption((option) =>
      option
        .setName("user")
        .setDescription("Optional: User name or Discord ID to view punishments")
        .setRequired(false)
    );

  name = "punished";
  description = "Displays punishment records of users";
  buttonIds = [];

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const userInput = interaction.options.getString("user", false);

    try {
      if (userInput) {
        const player = await PrismaUtils.findPlayer(userInput);

        if (!player) {
          await interaction.editReply(
            `❌ **Player "${userInput}" not found.**`
          );
          return;
        }

        const punishments = await prisma.playerPunishment.findMany({
          where: { playerId: player.id },
        });

        if (punishments.length === 0) {
          await interaction.editReply(
            `✅ **${userInput} has never been punished.**`
          );
          return;
        }

        const punishmentDetails = punishments.map((punishment) => {
          const reasonsWithDates = punishment.reasons
            .map((reason, i) => {
              const formattedDate = new Intl.DateTimeFormat("en-US", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              }).format(punishment.punishmentDates[i]);
              return `• ${reason} - ${formattedDate}`;
            })
            .join("\n");

          const strikeCount = punishment.strikeCount;
          const expiryDate = punishment.punishmentExpiry
            ? `<t:${Math.floor(punishment.punishmentExpiry.getTime() / 1000)}:F>`
            : "No expiry";

          return `**Reasons & Dates:**\n${reasonsWithDates}\n\n**Strike Count:** ${strikeCount}\n**Expiry:** ${expiryDate}`;
        });

        await interaction.editReply(
          `📋 **Punishment record for ${userInput}:**\n\n${punishmentDetails.join("\n\n")}`
        );
      } else {
        const punishedUsers = await prisma.playerPunishment.findMany({
          where: {
            punishmentExpiry: { not: null },
          },
          include: { player: true },
        });

        if (punishedUsers.length === 0) {
          await interaction.editReply(
            "✅ **There are currently no punished users.**"
          );
          return;
        }

        const userDetails = punishedUsers.map((entry, index) => {
          const username =
            entry.player.latestIGN ||
            `Discord: <@${entry.player.discordSnowflake}>`;
          const expiryDate = entry.punishmentExpiry
            ? `<t:${Math.floor(entry.punishmentExpiry.getTime() / 1000)}:R>`
            : "No expiry";

          return `**#${index + 1}. ${username}**\n   **Expiry:** ${expiryDate}\n   **Strikes:** ${entry.strikeCount}`;
        });

        await interaction.editReply(
          `📜 **The Naughty list:**\n\n${userDetails.join("\n\n")}`
        );
      }
    } catch (error) {
      console.error(error);
      await interaction.editReply(
        "❌ **An error occurred while retrieving punishment records.**"
      );
    }
  }
}
