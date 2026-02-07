import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { PrismaUtils } from "../util/PrismaUtils";
import { escapeText } from "../util/Utils";

export default class IgnsCommand implements Command {
  public data: SlashCommandBuilder;
  public name = "igns";
  public description = "List Minecraft accounts associated with a user";
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addStringOption((option) =>
        option
          .setName("user")
          .setDescription(
            "Username or Discord mention/ID (defaults to you if omitted)"
          )
          .setRequired(false)
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const input = interaction.options.getString("user");
    const identifier =
      input && input.trim().length > 0 ? input : interaction.user.id;

    const player = await PrismaUtils.findPlayer(identifier);
    if (!player) {
      await interaction.editReply({
        content: "Player not found.",
      });
      return;
    }

    const accounts = Array.isArray(player.minecraftAccounts)
      ? player.minecraftAccounts
      : [];

    const titleDisplay = player.latestIGN
      ? `${escapeText(player.latestIGN)})`
      : player.discordSnowflake;

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle(`Minecraft Accounts for ${titleDisplay}`);

    if (accounts.length === 0) {
      embed.setDescription(
        "No Minecraft accounts are registered for this user."
      );
    } else {
      const lines = accounts
        .slice()
        .reverse()
        .map((acc, idx) => `${idx + 1}. ${escapeText(acc)}`);
      const value = lines.join("\n");
      embed.addFields({ name: "Accounts", value, inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
  }
}
