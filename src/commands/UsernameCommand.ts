import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface";
import { MojangAPI } from "../api/MojangAPI";
import { prismaClient } from "../database/prismaClient";
import { escapeText } from "../util/Utils";
import { PermissionsUtil } from "../util/PermissionsUtil";


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
    if (!(await PermissionsUtil.isUserAuthorised(interaction))) return;

    const oldUsername = interaction.options.getString("oldusername", true);
    const newUsername = interaction.options.getString("newusername", true);
    const safeOldUsername = escapeText(oldUsername);
    const safeNewUsername = escapeText(newUsername);

    await interaction.deferReply();

    if (oldUsername.toLowerCase() === newUsername.toLowerCase()) {
      await interaction.editReply("Old and new usernames cannot be the same.");
      return;
    }

    const oldLookup = await MojangAPI.lookupUsername(oldUsername);
    const newLookup = await MojangAPI.lookupUsername(newUsername);
    if (oldLookup.status !== "found" || newLookup.status !== "found") {
      const unavailable = oldLookup.status === "unavailable" ||
        newLookup.status === "unavailable";
      await interaction.editReply(
        unavailable
          ? "Minecraft identity service is unavailable. No account changes were made."
          : "One or both Minecraft usernames could not be verified. No account changes were made."
      );
      return;
    }
    const oldUUID = oldLookup.uuid;
    const newUUID = newLookup.uuid;

    const oldPlayer = await prismaClient.player.findFirst({
      where: { primaryMinecraftAccount: oldUUID },
    });

    if (!oldPlayer) {
      await interaction.editReply(
        `No player found with username: ${safeOldUsername}`
      );
      return;
    }

    // Check both primary and secondary associations, including case-only name
    // conflicts. This is a precondition, NOT a cross-player uniqueness guarantee.
    const conflictingPlayers = await prismaClient.player.findMany({
      where: {
        OR: [
          { primaryMinecraftAccount: newUUID },
          { minecraftAccounts: { has: newUUID } },
          { latestIGN: { equals: newUsername, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });

    if (conflictingPlayers.length) {
      await interaction.editReply(
        `The requested identity is already associated with a player; no change was made: ${safeNewUsername}`
      );
      return;
    }

    // Compare-and-swap protects against two concurrent changes to the *same*
    // primary account. A global UUID claim table is still needed to exclude
    // simultaneous claims by different players.
    let changed: { count: number };
    try {
      changed = await prismaClient.player.updateMany({
        where: { id: oldPlayer.id, primaryMinecraftAccount: oldUUID },
        data: {
          primaryMinecraftAccount: newUUID,
          latestIGN: newUsername,
        },
      });
    } catch (error) {
      console.error("[UsernameCommand] Identity mutation completion uncertain; organiser review required", error);
      await interaction.editReply(
        "Unable to confirm the account update. An organiser must check its current association before retrying."
      );
      return;
    }
    if (changed.count !== 1) {
      await interaction.editReply(
        "The account association changed during this request. No further update was applied; review the current account owner."
      );
      return;
    }

    console.info("[UsernameCommand] Conditional identity update committed");

    await interaction.editReply(
      `✅ Successfully updated player **${oldPlayer.id}**:\n` +
        `• From **${safeOldUsername}** (${oldUUID})\n` +
        `• To **${safeNewUsername}** (${newUUID})`
    );
  }
}
