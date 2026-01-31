import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { escapeText } from "../util/Utils";
import { ConfigManager } from "../ConfigManager";

type HelpCategory = "user" | "organiser" | "dev";

const MANUAL_OVERRIDES: Record<string, HelpCategory> = {
  performance: "dev",
  test: "dev",
  nickname: "user",
  plan: "user",
  register: "user",
  unregister: "user",
  captainnominate: "user",
  team: "user",
};

const ORGANISER_HINTS = [
  "isUserAuthorised",
  "organiserRole",
  "hasRole",
  "PermissionsUtil.hasRole",
];

const DEV_HINTS = ["isDebugEnabled", "config.dev", "dev.enabled", "dev.guildId"];

export default class HelpCommand implements Command {
  public name = "help";
  public description = "Show available commands";
  public buttonIds: string[] = [];
  private readonly getCommands: () => Command[];

  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addStringOption((opt) =>
      opt
        .setName("scope")
        .setDescription("Which commands to show")
        .setRequired(false)
        .addChoices(
          { name: "organisers", value: "organiser" },
          { name: "dev", value: "dev" }
        )
    );

  constructor(getCommands: () => Command[]) {
    this.getCommands = getCommands;
  }

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const scope =
      (interaction.options.getString("scope") as HelpCategory | null) ?? "user";

    const commands = this.getCommands().filter((cmd) => cmd.name !== this.name);
    const filtered = commands.filter((cmd) =>
      this.inferCategory(cmd) === scope
    );

    const title =
      scope === "organiser"
        ? "Organiser Commands"
        : scope === "dev"
          ? "Dev Commands"
          : "User Commands";

    const description =
      filtered.length > 0
        ? filtered
            .map((cmd) => {
              const desc = cmd.description
                ? ` — ${escapeText(cmd.description)}`
                : "";
              return `/${cmd.name}${desc}`;
            })
            .sort((a, b) => a.localeCompare(b))
            .join("\n")
        : "No commands matched this category.";

    const embed = new EmbedBuilder().setTitle(title).setDescription(description);

    if (scope === "dev" && !ConfigManager.getConfig().dev.enabled) {
      embed.setFooter({
        text: "Dev mode is disabled in config.",
      });
    }

    await interaction.reply({ embeds: [embed] });
  }

  private inferCategory(command: Command): HelpCategory {
    const override = MANUAL_OVERRIDES[command.name];
    if (override) return override;
    const execSource = command.execute?.toString?.() ?? "";
    const handleSource = command.handleButtonPress?.toString?.() ?? "";
    const source = `${execSource}\n${handleSource}`;

    if (DEV_HINTS.some((hint) => source.includes(hint))) {
      return "dev";
    }

    if (ORGANISER_HINTS.some((hint) => source.includes(hint))) {
      return "organiser";
    }

    return "user";
  }
}
