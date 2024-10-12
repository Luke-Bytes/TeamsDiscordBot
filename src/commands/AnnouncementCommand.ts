import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  TextChannel,
  Message,
} from "discord.js";
import { Command } from "./CommandInterface";
import { log } from "console";
import { AnniMap } from "@prisma/client";
import { randomEnum } from "Utils";

export default class AnnouncementCommand implements Command {
  data: SlashCommandBuilder;
  name: string;
  description: string;
  private mapEmojiMap: Record<string, string> = {
    //TODO add relevant emojis
    Coastal: "🗺️",
    Duelstal: "🗺️",
    Clashstal: "🗺️",
    Canyon: "🗺️",
    Nature: "🗺️",
    Siege: "🗺️",
    Andorra: "🗺️",
    Arid: "🗺️",
    Aftermath: "🗺️",
    Dredge: "🗺️",
    Villages: "🗺️",
    Chasm: "🌍",
  };
  private defaultEmojis: string[] = ["🟠", "🟡", "🟢", "🔵", "🟣"];

  constructor() {
    this.name = "announce";
    this.description = "Create a game announcement";

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
          .setDescription("Map? (vote <maps>/random/<map>)")
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
      ) as SlashCommandBuilder;
  }

  private getMap(mapOption: string) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const when = interaction.options.getString("when", true);
    const minerushing = interaction.options.getString("minerushing", true);
    const bannedClasses = interaction.options.getString("banned_classes", true);
    const map = interaction.options.getString("map", true);
    const organiser = interaction.options.getString("organiser");
    const host = interaction.options.getString("host");

    await interaction.deferReply();

    let chosenMap;
    if (map.startsWith("vote ")) {
      log(map.substring(5));
    } else if (map === "random") {
      chosenMap = randomEnum(AnniMap);
    } else {
      if ((Object.values(AnniMap) as string[]).includes(map)) {
        chosenMap = map;
      } else {
        // error
      }
    }

    // Handle map vote if more than 1 map
    if (maps.length > 1) {
      const mapVoteMessage = await (interaction.channel as TextChannel).send(
        "Map vote!"
      );
      await this.addMapEmojis(mapVoteMessage, maps);
      this.startMapVoteTimer(mapVoteMessage, when, maps);
    }
  }

  async addMapEmojis(message: Message, maps: string[]) {
    for (let i = 0; i < maps.length; i++) {
      const map = maps[i].trim();
      const emoji =
        this.mapEmojiMap[map] ||
        this.defaultEmojis[i % this.defaultEmojis.length];
      await message.react(emoji);
    }
  }

  startMapVoteTimer(message: Message, eventTime: number, maps: string[]) {
    const voteEndTime = eventTime * 1000 - 15 * 60 * 1000;
    const delay = voteEndTime - Date.now();

    setTimeout(async () => {
      const winningMap = this.tallyVotes(message, maps);
      GameData.addMapVote(winningMap);
      await message.edit(`The map will be **${winningMap}**!`);
    }, delay);
  }

  startMinerushingVoteTimer(message: Message, eventTime: number) {
    const delay = eventTime * 1000 - Date.now();

    setTimeout(async () => {
      const minerushingResult = this.tallyMinerushingVotes(message);
      GameData.addMinerushingVote(minerushingResult);
      await message.edit(
        minerushingResult === "yes"
          ? "Minerushing will be allowed!"
          : "Minerushing will be disallowed!"
      );
    }, delay);
  }

  tallyVotes(message: Message, maps: string[]): string {
    const reactions = message.reactions.cache;
    let maxVotes = 0;
    let winningMap = maps[0];

    reactions.forEach((reaction) => {
      const emoji = reaction.emoji.name;

      if (typeof emoji === "string") {
        const mapIndex = Object.values(this.mapEmojiMap).indexOf(emoji);
        const mapName =
          mapIndex !== -1 ? Object.keys(this.mapEmojiMap)[mapIndex] : null;
        const count = reaction.count - 1;

        if (count > maxVotes && mapName) {
          maxVotes = count;
          winningMap = mapName;
        }
      }
    });

    return winningMap;
  }

  tallyMinerushingVotes(message: Message): string {
    const reactions = message.reactions.cache;
    const swords = reactions.get("⚔️")?.count ?? 0;
    const shield = reactions.get("🛡️")?.count ?? 0;

    return swords > shield ? "yes" : "no";
  }
}
