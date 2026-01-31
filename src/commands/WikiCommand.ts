import {
  ChatInputCommandInteraction,
  EmbedBuilder,
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

    const normalizedInput = this.normalize(name);
    if (type === "map") {
      const map = this.findEnumMatch(AnniMap, normalizedInput);
      if (!map) {
        await DiscordUtil.reply(
          interaction,
          `Unknown map: ${escapeText(name)}.`,
          true
        );
        return;
      }
      const mapTitle = this.formatWikiTitle(map);
      const mapUrl = `https://wiki.shotbow.net/${mapTitle}`;
      // TODO: Attach local map images from config.wiki.mapImageDir when available.
      const imageUrl = await this.fetchMapImageUrl(mapTitle);
      const embed = imageUrl
        ? new EmbedBuilder()
            .setTitle(escapeText(mapTitle))
            .setImage(imageUrl)
        : null;
      await interaction.reply({
        content: `↗ ${mapUrl}`,
        embeds: embed ? [embed] : [],
      });
      return;
    }

    const klass = this.findEnumMatch(AnniClass, normalizedInput);
    if (!klass) {
      await DiscordUtil.reply(
        interaction,
        `Unknown class: ${escapeText(name)}.`,
        true
      );
      return;
    }
    const classTitle = this.formatWikiTitle(klass);
    await interaction.reply({
      content: `↗ https://wiki.shotbow.net/${classTitle}`,
    });
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

  private async fetchMapImageUrl(mapTitle: string): Promise<string | null> {
    try {
      const apiUrl = `https://wiki.shotbow.net/api.php?action=query&titles=File:${encodeURIComponent(
        mapTitle
      )}.png&prop=imageinfo&iiprop=url&format=json`;
      console.log(`[WikiCommand] Fetching map image via API: ${apiUrl}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(apiUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "TeamsDiscordBot/1.0 (+https://anniwars.win/)",
          Accept: "application/json",
        },
      });
      clearTimeout(timeout);
      console.log(`[WikiCommand] API status for ${mapTitle}: ${res.status}`);
      const text = await res.text().catch(() => "");
      const data = ((): {
        query?: {
          pages?: Record<
            string,
            { imageinfo?: Array<{ url?: string | null }> }
          >;
        };
      } | null => {
        try {
          return text ? JSON.parse(text) : null;
        } catch {
          return null;
        }
      })();
      if (!res.ok) {
        // Some configs return 403 with a usable JSON payload.
        if (!data) {
          const snippet = text?.slice(0, 300).replace(/\s+/g, " ");
          console.log(
            `[WikiCommand] Failed to parse API body for ${mapTitle}: ${snippet}`
          );
          return null;
        }
      }
      const pages = data?.query?.pages;
      const firstPage = pages ? Object.values(pages)[0] : null;
      let url = firstPage?.imageinfo?.[0]?.url ?? null;
      if (!url && text) {
        const match = text.match(/"url":"([^"]+\.png)"/i);
        url = match?.[1] ?? null;
      }
      console.log(
        `[WikiCommand] Image match for ${mapTitle}: ${url ?? "none"}`
      );
      if (!url) return null;
      return url;
    } catch {
      console.log(`[WikiCommand] Failed to fetch image for ${mapTitle}`);
      return null;
    }
  }

  private formatWikiTitle(value: string): string {
    const lower = value.toLowerCase();
    if (!lower) return value;
    return lower[0].toUpperCase() + lower.slice(1);
  }

  // TODO: Support local map image attachments once we decide on storage.
}
