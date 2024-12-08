import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface";
import { CommandHandler } from "./CommandHandler";
import { ConfigManager } from "../ConfigManager";
import { GameInstance } from "../database/GameInstance";

export default class ScenarioCommand implements Command {
  public data = new SlashCommandBuilder()
    .setName("scenario")
    .setDescription("Run predefined scenarios.")
    .addSubcommand((sub) =>
      sub
        .setName("game-playing")
        .setDescription("Sets the bot up for a game-playing scenario.")
    )
    .addSubcommand((sub) =>
      sub
        .setName("game-announce")
        .setDescription("Sets the bot up for a game-announce scenario.")
    )
    .addSubcommand((sub) =>
      sub.setName("game-prepare").setDescription("Prepares the bot for a game.")
    );

  public name = "scenario";
  public description = "Run predefined scenarios.";
  public buttonIds: string[] = [];

  constructor() {
  }

  public async execute(interaction: ChatInputCommandInteraction) {
    const config = ConfigManager.getConfig();

    if (!config.dev.enabled) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "This command is only available in development mode.",
          ephemeral: true,
        });
      }
      return;
    }

    const subCommand = interaction.options.getSubcommand();
    const gameInstance = GameInstance.getInstance();

    if (subCommand === "game-playing") {
      await gameInstance.testValues("red-blue");

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(
          `The ${subCommand.replace("-", " ")} scenario has been initialised!`
        );
      }
    } else if (subCommand === "game-announce") {
      await gameInstance.testValues("none");

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply("Game is now announced!");
      }
    } else if (subCommand === "game-prepare") {
      await gameInstance.testValues("undecided");

      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply("Game is now ready to play!");
      }
    }

    if (!interaction.replied && !interaction.deferred) {
      await interaction.followUp({
        content: `${subCommand.replace("-", " ")} scenario setup complete.`,
        ephemeral: true,
      });
    }
  }
}
