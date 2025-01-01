import { EmbedBuilder } from "discord.js";
import { prismaClient } from "../../database/prismaClient";
import { EloUtil } from "../../util/EloUtil";

export class LeaderBoardFeed {
  private getLeaderboardEntryString(
    rank: number,
    ign: string,
    elo: number,
    winLossRatio: number
  ): string {
    const rankEmojis = [
      "🥇",
      "🥈",
      "🥉",
      "4️⃣",
      "5️⃣",
      "6️⃣",
      "7️⃣",
      "8️⃣",
      "9️⃣",
      "🔟",
    ];
    const rankEmoji = rankEmojis[rank - 1] || "🔢";
    const eloEmoji = EloUtil.getEloEmoji(elo);
    return `${rankEmoji} **${ign}** ${eloEmoji} ─ ${elo} | W/L: ${winLossRatio.toFixed(1)}`;
  }

  public async generateEmbed(): Promise<EmbedBuilder> {
    try {
      const allPlayers = await prismaClient.player.findMany({
        orderBy: {
          elo: "desc",
        },
      });

      const topTen = allPlayers.slice(0, 10).map(
        (
          playerData: {
            latestIGN: any;
            elo: any;
            losses: number;
            wins: number;
          },
          index: number
        ) => ({
          rank: index + 1,
          ign: playerData.latestIGN ?? "N/A",
          elo: playerData.elo,
          winLossRatio:
            playerData.losses > 0
              ? playerData.wins / playerData.losses
              : playerData.wins,
        })
      );

      const embed = new EmbedBuilder()
        .setColor("#FFD700")
        .setTitle("🏆 Friendly Wars Leaderboards 🏆")
        .setDescription("The top-rated players this season!")
        .setTimestamp();

      topTen.forEach(
        (player: {
          rank: number;
          ign: string;
          elo: number;
          winLossRatio: number;
        }) => {
          embed.addFields({
            name: this.getLeaderboardEntryString(
              player.rank,
              player.ign,
              player.elo,
              player.winLossRatio
            ),
            value: "\u200b",
            inline: false,
          });
        }
      );

      return embed;
    } catch (error) {
      console.error("Error generating leaderboard feed:", error);
      throw new Error("Failed to generate leaderboard feed.");
    }
  }
}
