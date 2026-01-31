import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface";
import { DiscordUtil } from "../util/DiscordUtil";

export default class WebsiteCommand implements Command {
  public name = "website";
  public description = "Get the official website link";
  public buttonIds: string[] = [];

  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description);

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    await DiscordUtil.reply(
      interaction,
      "Official website:\n```\nhttps://anniwars.win/\n```",
      true
    );
  }
}
