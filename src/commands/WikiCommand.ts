import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { DiscordUtil } from "../util/DiscordUtil";
import { AnniClass, AnniMap } from "@prisma/client";
import { escapeText } from "../util/Utils";

type WikiScope = "map" | "class";

export default class WikiCommand implements Command {
  public name = "wiki";
  public description = "Get the Shotbow wiki link";
  public buttonIds: string[] = [];

  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("What kind of page to link")
        .setRequired(false)
        .addChoices(
          { name: "map", value: "map" },
          { name: "class", value: "class" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("name")
        .setDescription("Map/Class name")
        .setRequired(false)
        .setAutocomplete(true)
    );

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const type = interaction.options.getString("type") as WikiScope | null;
    const name = interaction.options.getString("name");

    if (!type && !name) {
      await interaction.reply({
        content: "↗ https://wiki.shotbow.net/",
      });
      return;
    }

    if (!type || !name) {
      await DiscordUtil.reply(
        interaction,
        "Please provide both a type (map/class) and a name.",
        true
      );
      return;
    }

    const match = this.findEnumMatch(
      type === "map" ? AnniMap : AnniClass,
      this.normalize(name)
    );
    if (!match) {
      await DiscordUtil.reply(
        interaction,
        `Unknown ${type}: ${escapeText(name)}.`,
        true
      );
      return;
    }
    const title = this.formatWikiTitle(match);
    // TODO: Add locally stored top-down map images and compact class summaries,
    // keyed by the bot enums with source article URLs. Avoid live wiki requests:
    // Cloudflare challenges prevent reliable unattended access.
    await interaction.reply({
      content: `↗ https://wiki.shotbow.net/${encodeURIComponent(title)}`,
      allowedMentions: { parse: [] },
    });
  }

  async handleAutocomplete(
    interaction: AutocompleteInteraction
  ): Promise<void> {
    const type = interaction.options.getString("type");
    const names =
      type === "map"
        ? Object.values(AnniMap)
        : type === "class"
          ? Object.values(AnniClass)
          : [...Object.values(AnniMap), ...Object.values(AnniClass)];
    const query = this.normalize(String(interaction.options.getFocused()));
    await interaction.respond(
      names
        .filter((name) => this.normalize(name).includes(query))
        .slice(0, 25)
        .map((name) => ({ name: this.formatWikiTitle(name), value: name }))
    );
  }

  private normalize(value: string): string {
    return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  }

  private findEnumMatch<T extends Record<string, string>>(
    enumObj: T,
    normalizedInput: string
  ): string | null {
    for (const key of Object.keys(enumObj)) {
      const normalizedKey = this.normalize(key);
      if (normalizedKey === normalizedInput) {
        return enumObj[key as keyof T];
      }
    }
    return null;
  }

  private formatWikiTitle(value: string): string {
    const lower = value.toLowerCase();
    if (!lower) return value;
    return lower[0].toUpperCase() + lower.slice(1);
  }
}
