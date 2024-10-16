import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  Channel,
  GuildBasedChannel,
  Embed,
  EmbedBuilder,
  ApplicationCommandOptionData,
  ButtonInteraction,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { log } from "console";
import { AnniClass, AnniMap } from "@prisma/client";
import { randomEnum } from "../Utils";
import { ConfigManager } from "../ConfigManager";
import { GameManager } from "../logic/GameManager";
import { Chrono, parseDate } from "chrono-node";
import { createGameAnnouncementPreviewEmbed } from "util/EmbedUtil";

export default class AnnouncementCommand implements Command {
  public data: SlashCommandOptionsOnlyBuilder;
  public name: string = "announce";
  public description: string = "Create a game announcement";
  public buttonIds: string[] = ["announcement-confirm"];

  constructor() {
    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description)
      .addStringOption((option) =>
        option.setName("when").setDescription("Date").setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("minerushing")
          .setDescription("Minerushing? (poll/yes/no)")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("banned_classes")
          .setDescription(
            "Banned classes separated by a comma, or 'none' for none."
          )
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("map")
          .setDescription("Map? (poll <maps>/random/<map>)")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("organiser")
          .setDescription("Organiser Name")
          .setRequired(false)
      )
      .addStringOption((option) =>
        option.setName("host").setDescription("Host Name").setRequired(false)
      );
  }

  private getMap(mapOption: string) {
    if (mapOption.startsWith("vote ")) {
      const rest = mapOption
        .substring(5)
        .toUpperCase()
        .split(",")
        .map((v) => v.trim());

      for (let i = 0; i < rest.length; i++) {
        if (!Object.values(AnniMap).includes(rest[i] as AnniMap)) {
          return {
            error: `Map '${rest[i]}' not recognized.`,
          };
        }
      }

      return {
        error: false,
        chooseMapType: "vote",
        maps: rest as AnniMap[],
      } as const;
    } else if (mapOption === "random") {
      return {
        error: false,
        chooseMapType: "random",
        map: randomEnum(AnniMap),
      } as const;
    } else {
      if (
        (Object.values(AnniMap) as string[]).includes(mapOption.toUpperCase())
      ) {
        return {
          error: false,
          chooseMapType: "specific",
          map: mapOption.toUpperCase() as AnniMap,
        } as const;
      } else {
        return {
          error: "Could not detect map(s).",
        } as const;
      }
    }
  }

  private getBannedClasses(bannedClassesOption: string) {
    if (bannedClassesOption === "none")
      return {
        error: false,
        bannedClasses: [] as AnniClass[],
      } as const;

    const kits = bannedClassesOption
      .toUpperCase()
      .split(",")
      .map((v) => v.trim());

    for (let i = 0; i < kits.length; i++) {
      if (!Object.values(AnniClass).includes(kits[i] as AnniClass)) {
        return {
          error: `Class '${kits[i]}' not recognized.`,
        } as const;
      }
    }

    return {
      error: false,
      bannedClasses: kits as AnniClass[],
    } as const;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = ConfigManager.getConfig();
    const when = interaction.options.getString("when", true);
    const minerushing = interaction.options.getString("minerushing", true);
    const bannedClassesOption = interaction.options.getString(
      "banned_classes",
      true
    );
    const map = interaction.options.getString("map", true);
    const organiser = interaction.options.getString("organiser");
    const host = interaction.options.getString("host");

    const game = GameManager.getGame();

    await interaction.deferReply();

    const chosenMap = this.getMap(map);

    if (chosenMap.error) {
      await interaction.editReply(chosenMap.error);
      return;
    } else {
      switch (chosenMap.chooseMapType) {
        case "vote":
          const channel = interaction.guild?.channels.cache.find(
            (c) => c.id === config.channels.mapVote
          );
          if (!channel) {
            await interaction.editReply(
              "Could not find map vote channel. Please contact devs"
            );
            return;
          }
          game.startMapVote(channel, chosenMap.maps);
          break;
        case "random":
        case "specific":
          game.setMap(chosenMap.map);
          break;
      }
    }

    const date = parseDate(when, undefined, {
      forwardDate: true,
    });

    if (!date) {
      await interaction.editReply(
        "Date could not be deduced. Please try again"
      );
      return;
    }

    game.startTime = date;

    const bannedClasses = this.getBannedClasses(bannedClassesOption);

    if (!bannedClasses.error) {
      game.settings.bannedClasses = bannedClasses.bannedClasses;
    } else {
      await interaction.editReply(bannedClasses.error);
      return;
    }

    const embed = createGameAnnouncementPreviewEmbed(game);

    await interaction.editReply(embed);
  }

  public async handleButtonPress(
    interaction: ButtonInteraction
  ): Promise<void> {}

  //startMinerushingVoteTimer(message: Message, eventTime: number) {
  //  const delay = eventTime * 1000 - Date.now();

  //  setTimeout(async () => {
  //    const minerushingResult = this.tallyMinerushingVotes(message);
  //    GameData.addMinerushingVote(minerushingResult);
  //    await message.edit(
  //      minerushingResult === "yes"
  //        ? "Minerushing will be allowed!"
  //        : "Minerushing will be disallowed!"
  //    );
  //  }, delay);
  //}

  //tallyVotes(message: Message, maps: string[]): string {
  //  const reactions = message.reactions.cache;
  //  let maxVotes = 0;
  //  let winningMap = maps[0];

  //  reactions.forEach((reaction) => {
  //    const emoji = reaction.emoji.name;

  //    if (typeof emoji === "string") {
  //      const mapIndex = Object.values(this.mapEmojiMap).indexOf(emoji);
  //      const mapName =
  //        mapIndex !== -1 ? Object.keys(this.mapEmojiMap)[mapIndex] : null;
  //      const count = reaction.count - 1;

  //      if (count > maxVotes && mapName) {
  //        maxVotes = count;
  //        winningMap = mapName;
  //      }
  //    }
  //  });

  //  return winningMap;
  //}

  //tallyMinerushingVotes(message: Message): string {
  //  const reactions = message.reactions.cache;
  //  const swords = reactions.get("⚔️")?.count ?? 0;
  //  const shield = reactions.get("🛡️")?.count ?? 0;

  //  return swords > shield ? "yes" : "no";
  //}
}
