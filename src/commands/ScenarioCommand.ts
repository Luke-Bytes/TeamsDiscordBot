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
        .setName("game-ready")
        .setDescription("Sets the bot up for a game-ready scenario.")
    );

  public name = "scenario";
  public description = "Run predefined scenarios.";
  public buttonIds: string[] = [];

  private readonly commandHandler: CommandHandler;

  constructor(commandHandler: CommandHandler) {
    this.commandHandler = commandHandler;
  }

  public async execute(interaction: ChatInputCommandInteraction) {
    const config = ConfigManager.getConfig();

    if (!config.dev.enabled) {
      await interaction.reply({
        content: "This command is only available in development mode.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.options.getSubcommand() === "game-ready") {
      const gameInstance = GameInstance.getInstance();
      await gameInstance.testValues();
      await interaction.reply(
        "Game is now ready and test values have been initialised!"
      );
      const commandsToRun = ["register", "role", "team"];
      for (const cmdName of commandsToRun) {
        const cmd = this.commandHandler.commands.find(
          (c) => c.name === cmdName
        );
        if (cmd) {
          await cmd.execute(interaction);
        }
      }
      await interaction.reply({
        content: "Game-ready scenario setup complete.",
        ephemeral: true,
      });
    }
  }
}
