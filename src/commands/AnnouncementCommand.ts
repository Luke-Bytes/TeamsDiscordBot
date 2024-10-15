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
import { AnniMap } from "@prisma/client";
import { randomEnum } from "../Utils";
import { ConfigManager } from "../ConfigManager";
import { GameManager } from "../logic/GameManager";
import { Chrono, parseDate } from "chrono-node";

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
          .setDescription("Banned classes, separated by a comma.")
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

  private getMap(mapOption: string):
    | {
        chooseMapType: "vote";
        maps: AnniMap[];
      }
    | {
        chooseMapType: "random" | "specific";
        map: AnniMap;
      }
    | {
        chooseMapType: "error";
        error: string;
      } {
    if (mapOption.startsWith("vote ")) {
      const rest = mapOption.substring(5);
      return {
        chooseMapType: "vote",
        maps: rest.toUpperCase().split(",") as AnniMap[],
      };
    } else if (mapOption === "random") {
      return {
        chooseMapType: "random",
        map: randomEnum(AnniMap),
      };
    } else {
      if (
        (Object.values(AnniMap) as string[]).includes(mapOption.toUpperCase())
      ) {
        return {
          chooseMapType: "specific",
          map: mapOption as AnniMap,
        };
      } else {
        return {
          chooseMapType: "error",
          error: "Could not detect map(s).",
        };
      }
    }
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = ConfigManager.getConfig();
    const when = interaction.options.getString("when", true);
    const minerushing = interaction.options.getString("minerushing", true);
    const bannedClasses = interaction.options.getString("banned_classes", true);
    const map = interaction.options.getString("map", true);
    const organiser = interaction.options.getString("organiser");
    const host = interaction.options.getString("host");

    const game = GameManager.getGame();

    const message = await interaction.deferReply();

    const chosenMap = this.getMap(map);

    switch (chosenMap.chooseMapType) {
      case "vote":
        const channel = interaction.guild?.channels.cache.find(
          (c) => c.id === config.channels.mapVote
        );
        if (!channel) {
          await message.edit("Could not find map vote channel.");
          return;
        }
        game.startMapVote(channel, chosenMap.maps);
        break;
      case "random":
      case "specific":
        game.setMap(chosenMap.map);
        break;
      case "error":
        await interaction.editReply({
          content: "Invalid map option",
        });
        break;
    }

    const date = parseDate(when, undefined, {
      forwardDate: true,
    });

    await interaction.editReply({
      content: date?.toString(),
    });

    game.announced = true;
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
