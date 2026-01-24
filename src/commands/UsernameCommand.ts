import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface";
import { MojangAPI } from "../api/MojangAPI";
import { PrismaClient } from "@prisma/client";
import { escapeText } from "../util/Utils";

const prisma = new PrismaClient();

export default class UsernameCommand implements Command {
  name = "username";
  description = "Manage usernames";
  buttonIds = [];

  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("update")
        .setDescription("Update a user's Minecraft username")
        .addStringOption((option) =>
          option
            .setName("oldusername")
            .setDescription("Old Minecraft username")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("newusername")
            .setDescription("New Minecraft username")
            .setRequired(true)
        )
    );

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.isChatInputCommand()) return;
    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== "update") return;

    const oldUsername = interaction.options.getString("oldusername", true);
    const newUsername = interaction.options.getString("newusername", true);
    const safeOldUsername = escapeText(oldUsername);
    const safeNewUsername = escapeText(newUsername);

    await interaction.deferReply({ ephemeral: false });

    if (oldUsername.toLowerCase() === newUsername.toLowerCase()) {
      await interaction.editReply("Old and new usernames cannot be the same.");
      return;
    }

    const oldUUID = await MojangAPI.usernameToUUID(oldUsername);
    const newUUID = await MojangAPI.usernameToUUID(newUsername);

    if (!oldUUID || !newUUID) {
      await interaction.editReply("Failed to resolve one or both UUIDs.");
      return;
    }

    const oldPlayer = await prisma.player.findFirst({
      where: { primaryMinecraftAccount: oldUUID },
    });

    if (!oldPlayer) {
      await interaction.editReply(
        `No player found with username: ${safeOldUsername}`
      );
      return;
    }

    const newPlayer = await prisma.player.findFirst({
      where: { primaryMinecraftAccount: newUUID },
    });

    if (newPlayer) {
      await interaction.editReply(
        `Another player already uses the username: ${safeNewUsername}`
      );
      return;
    }

    await prisma.player.update({
      where: { id: oldPlayer.id },
      data: {
        primaryMinecraftAccount: newUUID,
        latestIGN: newUsername,
      },
    });

    console.log(
      `[UsernameCommand] Updated player ${oldPlayer.id}: ${oldUsername} (${oldUUID}) → ${newUsername} (${newUUID})`
    );

    await interaction.editReply(
      `✅ Successfully updated player **${oldPlayer.id}**:\n` +
        `• From **${safeOldUsername}** (${oldUUID})\n` +
        `• To **${safeNewUsername}** (${newUUID})`
    );
  }
}
