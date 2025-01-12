import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { PermissionsUtil } from "../util/PermissionsUtil.js";
import { GameInstance } from "../database/GameInstance";
import { prismaClient } from "../database/prismaClient";

export default class MassRegisterCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "massregister";
  public description = "Register a list of players (organisers only).";
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addStringOption((option) =>
        option
          .setName("playerlist")
          .setDescription("A space-separated list of in-game names.")
          .setRequired(true)
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = interaction.member as GuildMember;

    if (!member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await interaction.reply({
        content: "You do not have permission to use this command.",
        ephemeral: false,
      });
      return;
    }

    const currentGame = GameInstance.getInstance();
    if (!currentGame.announced) {
      await interaction.reply({
        content: "No game has been announced yet!",
        ephemeral: true,
      });
      return;
    }

    const playerList = interaction.options.getString("playerlist", true);
    const igns = playerList.split(" ").map((ign) => ign.trim());

    let successful: string[] = [];
    let failed: string[] = [];

    for (const ign of igns) {
      const player = await prismaClient.player.findFirst({
        where: { latestIGN: ign },
      });

      if (!player) {
        failed.push(ign);
        continue;
      }

      const existingPlayer = currentGame
        .getPlayers()
        .find((p) => p.discordSnowflake === player.discordSnowflake);

      if (existingPlayer) {
        failed.push(ign);
        continue;
      }

      // Add player to the game
      const result = await currentGame.addPlayerByDiscordId(
        player.discordSnowflake,
        ign
      );

      if (result.error) {
        failed.push(ign);
      } else {
        successful.push(ign);
      }
    }

    const successMessage = successful.length
      ? `Successfully registered: ${successful.join(", ")}.`
      : "";
    const failureMessage = failed.length
      ? `Skipped (not previously registered or already registered): ${failed.join(
          ", "
        )}.`
      : "";

    await interaction.reply({
      content: [successMessage, failureMessage].filter(Boolean).join("\n"),
      ephemeral: false,
    });
  }
}
