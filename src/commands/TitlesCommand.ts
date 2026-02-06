import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { TitleStore } from "../util/TitleStore";

export default class TitlesCommand implements Command {
  public name = "titles";
  public description = "View available titles and how to earn them";
  public buttonIds: string[] = [];
  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description);

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const titles = TitleStore.getTitlesWithReasons();
    const embed = new EmbedBuilder()
      .setTitle("🏷️ Available Titles")
      .setDescription(
        titles.length
          ? "Here are the current titles and how they are earned:"
          : "No titles have been defined yet."
      );

    if (titles.length) {
      if (titles.length <= 25) {
        embed.addFields(
          titles.map((title) => ({
            name: title.label,
            value: title.reasonText,
            inline: false,
          }))
        );
      } else {
        const lines = titles.map(
          (title) => `• **${title.label}** — ${title.reasonText}`
        );
        embed.setDescription(lines.join("\n"));
      }
    }

    await interaction.reply({ embeds: [embed] });
  }
}
