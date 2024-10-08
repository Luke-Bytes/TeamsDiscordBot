import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PlayerData } from "../database/PlayerData";
import { EloUtil } from "../util/EloUtil";

export default class LeaderboardsCommand implements Command {
  data: SlashCommandBuilder;
  name: string;
  description: string;
  playerDataList: PlayerData[];
  constructor() {
    this.name = "leaderboards";
    this.description = "Get leaderboards for the top-rated players.";

    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description);

    this.playerDataList = PlayerData.playerDataList;
  }

  private getLeaderboardEntryString(
    ign: string,
    elo: number,
    emoji: string,
    winLossRatio: number
  ) {
    return `${emoji} ${ign} **[${elo} ${EloUtil.getEloEmoji(
      elo
    )}]** ${winLossRatio} W/L`;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const topTen = this.playerDataList
      .toSorted((a, b) => {
        return b.getElo() - a.getElo();
      })
      .slice(0, 10)
      .map((playerData, i) => {
        const placeEmojis = [
          "first_place",
          "second_place",
          "third_place",
          "four",
          "five",
          "six",
          "seven",
          "eight",
          "nine",
          "keycap_ten",
        ];
        return {
          ign: playerData.getInGameName(),
          elo: playerData.getElo(),
          emoji: `:${placeEmojis[i]}:`,
          winLossRatio: playerData.getWins() / playerData.getLosses(),
        };
      });

    const currentPlace = this.playerDataList
      .toSorted((a, b) => {
        return b.getElo() - a.getElo();
      })
      .findIndex(
        (playerData) => playerData.getDiscordUserId() === interaction.user.id
      );

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("Friendly Wars Leaderboards");
    for (let i = 0; i < 3 && topTen[i]; i++) {
      embed.addFields({
        name: this.getLeaderboardEntryString(
          topTen[i].ign,
          topTen[i].elo,
          topTen[i].emoji,
          topTen[i].winLossRatio
        ),
        value: " ",
        inline: false,
      });
    }
    embed.addFields({
      name: " ",
      value:
        topTen
          .slice(3)
          .map((v, i) => {
            return this.getLeaderboardEntryString(
              v.ign,
              v.elo,
              v.emoji,
              v.winLossRatio
            );
          })
          .join("\n") || " ",
      inline: false,
    });

    embed.setFooter({
      text: `Your ranking: ${
        currentPlace === -1
          ? "(Unranked)"
          : "#" + (currentPlace + 1).toLocaleString()
      }`,
    });

    await interaction.reply({
      embeds: [embed],
    });
  }
}
