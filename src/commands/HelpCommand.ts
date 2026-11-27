import {
  ApplicationCommandOptionType,
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
  "debug-scenario": "dev",
  ask: "user",
  nickname: "user",
  plan: "user",
  register: "user",
  unregister: "user",
  captainnominate: "user",
  team: "organiser",
  game: "organiser",
  season: "organiser",
  class: "user",
  forfeit: "user",
  need: "user",
  vc: "user",
  sign: "user",
  spectate: "user",
  website: "user",
  shotbow: "user",
  wiki: "user",
  profile: "user",
  profilecreate: "user",
  titles: "user",
  title: "organiser",
  scripts: "organiser",
  tierlist: "organiser",
};

// Ordered by common player tasks. Unknown user commands still appear below.
const USER_SECTIONS = [
  {
    name: "Getting started & information",
    commands: ["ask", "website", "wiki", "shotbow", "maps"],
  },
  {
    name: "Joining games & events",
    commands: [
      "register",
      "unregister",
      "registered",
      "sign",
      "spectate",
      "need",
    ],
  },
  {
    name: "Teams & gameplay",
    commands: [
      "captainnominate",
      "class",
      "team",
      "teamless",
      "plan",
      "missing",
      "mvp",
      "forfeit",
    ],
  },
  {
    name: "Profiles, stats & rankings",
    commands: [
      "profile",
      "profilecreate",
      "stats",
      "leaderboards",
      "titles",
      "wrapped",
      "season",
    ],
  },
  {
    name: "Minecraft accounts & player records",
    commands: ["igns", "name", "nickname", "punished"],
  },
  {
    name: "Utilities",
    commands: ["game request", "vc", "timestamp", "coinflip"],
  },
  {
    name: "Friendly Wars scenarios",
    commands: [
      "game scenario guide",
      "game scenario open",
      "game scenario report-class",
    ],
  },
];

// Mixed-access command families must be classified by executable path.
const USER_PATHS: ReadonlySet<string> = new Set([
  "team list",
  "season view",
  "season status",
  "game request",
  "game scenario guide",
  "game scenario open",
  "game scenario report-class",
]);
const MIXED_ROOTS = new Set(["team", "season", "game"]);

type HelpEntry = Pick<Command, "name" | "description">;

function commandPaths(command: Command): HelpEntry[] {
  const data = command.data.toJSON?.();
  const paths: HelpEntry[] = [];
  if (data && "options" in data) {
    for (const option of data.options ?? []) {
      if (option.type === ApplicationCommandOptionType.Subcommand) {
        paths.push({
          name: `${command.name} ${option.name}`,
          description: option.description,
        });
      } else if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
        for (const sub of option.options ?? []) {
          paths.push({
            name: `${command.name} ${option.name} ${sub.name}`,
            description: sub.description,
          });
        }
      }
    }
  }
  return paths.length ? paths : [command];
}

function formatCommand(command: HelpEntry, emphasise = false): string {
  const name = `/${command.name}`;
  const description = command.description
    ? ` — ${escapeText(command.description)}`
    : "";
  return `${emphasise ? `**${name}**` : name}${description}`;
}

// Discord limits apply to all embeds in one message, so send each page
// separately. Preserve line boundaries for ordinary command descriptions.
function splitLines(lines: string[], limit: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const line of lines) {
    for (let offset = 0; offset < line.length; offset += limit) {
      const part = line.slice(offset, offset + limit);
      if (chunk && chunk.length + 1 + part.length > limit) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk += (chunk ? "\n" : "") + part;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

const ORGANISER_HINTS = [
  "isUserAuthorised",
  "organiserRole",
  "hasRole",
  "PermissionsUtil.hasRole",
];

const DEV_HINTS = [
  "isDebugEnabled",
  "config.dev",
  "dev.enabled",
  "dev.guildId",
];

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
    const filtered = commands.flatMap((command) => {
      const category = this.inferCategory(command);
      if (MIXED_ROOTS.has(command.name)) {
        return commandPaths(command).filter(
          (entry) => (USER_PATHS.has(entry.name) ? "user" : "organiser") === scope
        );
      }
      if (category !== scope) return [];
      return scope === "user" ? commandPaths(command) : [command];
    });

    const title =
      scope === "organiser"
        ? "Organiser Commands"
        : scope === "dev"
          ? "Dev Commands"
          : "User Commands";

    const pages = [new EmbedBuilder().setTitle(title)];
    let embed = pages[0];
    const addSection = (name: string, lines: string[]) => {
      for (const [index, value] of splitLines(lines, 1024).entries()) {
        const fieldName = index ? name + " (continued)" : name;
        // Leave room for titles and any footer.
        if ((embed.data.fields?.length ?? 0) >= 25 ||
            embed.length + fieldName.length + value.length > 5500) {
          embed = new EmbedBuilder().setTitle(title);
          pages.push(embed);
        }
        embed.addFields({ name: fieldName, value });
      }
    };

    if (scope === "user") {
      const remaining = new Map(filtered.map((cmd) => [cmd.name, cmd]));
      for (const section of USER_SECTIONS) {
        const lines: string[] = [];
        for (const name of section.commands) {
          for (const [path, command] of remaining) {
            if (path !== name && !path.startsWith(`${name} `)) continue;
            lines.push(formatCommand(command, true));
            remaining.delete(path);
          }
        }
        if (lines.length) {
          addSection(section.name, lines);
        }
      }
      if (remaining.size) {
        addSection("Other commands", [...remaining.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((cmd) => formatCommand(cmd, true)));
      }
      if (!filtered.length) {
        embed.setDescription("No commands matched this category.");
      }
    } else {
      const descriptions = splitLines(filtered.map((cmd) => formatCommand(cmd))
        .sort((a, b) => a.localeCompare(b)), 4096);
      embed.setDescription(descriptions[0] ?? "No commands matched this category.");
      for (const description of descriptions.slice(1)) {
        pages.push(new EmbedBuilder().setTitle(title).setDescription(description));
      }
    }

    if (scope === "dev" && !ConfigManager.getConfig().dev.enabled) {
      for (const page of pages) page.setFooter({
        text: "Dev mode is disabled in config.",
      });
    }

    await interaction.reply({ embeds: [pages[0]] });
    for (const page of pages.slice(1)) {
      await interaction.followUp({ embeds: [page] });
    }
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
