import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface";

export default class TestCommand implements Command {
  data: SlashCommandBuilder;
  name = "test";
  description = "Replies wiht a test message!";
  public buttonIds: string[] = [];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description);
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply("This is a test message!");
  }
}
