import {
  ChatInputCommandInteraction,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface.js";
import { AnniMap } from "@prisma/client";

export default class MapsCommand implements Command {
  data = new SlashCommandBuilder().setName("maps").setDescription("List all maps");
  name = "maps";
  description = "List all maps";
  buttonIds: string[] = [];

  async execute(
    interaction:
      | ChatInputCommandInteraction
      | MessageContextMenuCommandInteraction
      | UserContextMenuCommandInteraction
  ): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const formatted = (Object.values(AnniMap) as string[])
      .map((m) => m.toLowerCase())
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .sort((a, b) => a.localeCompare(b));

    const embed = new EmbedBuilder()
      .setTitle("Maps")
      .setDescription(formatted.map((n) => `• ${n}`).join("\n"));

    await interaction.reply({ embeds: [embed] });
  }
}
