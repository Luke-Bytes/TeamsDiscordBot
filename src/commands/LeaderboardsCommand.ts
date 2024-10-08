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
  constructor(playerDataList: PlayerData[]) {
    this.name = "leaderboards";
    this.description = "Get leaderboards for the top-rated players.";

    this.data = new SlashCommandBuilder()
      .setName(this.name)
      .setDescription(this.description);

    this.playerDataList = playerDataList;
  }

  private getLeaderboardEntryString(
    ign: string,
    elo: number,
    emoji: string,
    gamesPlayed: number
  ) {
    return `${emoji} ${ign} **[${elo} ${EloUtil.getEloEmoji(
      elo
    )}]** ${gamesPlayed} G`;
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
          gamesPlayed: playerData.getWins() + playerData.getLosses(),
        };
      });

    const currentPlace = this.playerDataList.findIndex(
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
          topTen[i].gamesPlayed
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
              v.gamesPlayed
            );
          })
          .join("\n") || " ",
      inline: false,
    });

    embed.setFooter({
      text: `Your position: ${
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
