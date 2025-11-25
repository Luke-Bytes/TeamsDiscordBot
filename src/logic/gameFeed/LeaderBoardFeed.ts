import { EmbedBuilder } from "discord.js";
import { prismaClient } from "../../database/prismaClient";
import { EloUtil } from "../../util/EloUtil";
import { ConfigManager } from "../../ConfigManager";
import { escapeText } from "../../util/Utils";

export class LeaderBoardFeed {
  private getLeaderboardEntryString(
    rank: number,
    ign: string,
    elo: number,
    winLossRatio: number,
    wins: number,
    losses: number,
    winStreak: number,
    loseStreak: number
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
    let winLossDisplay = winLossRatio.toFixed(1);

    let extraEmojis = "";
    if (wins > 0 && losses === 0) {
      extraEmojis += " 💯";
    }
    if (winStreak >= 3) {
      extraEmojis += " 🔥";
    }
    if (loseStreak >= 3) {
      extraEmojis += " 😢";
    }
    return `${rankEmoji} **${escapeText(ign)}** ${eloEmoji} ${elo} | W/L: ${winLossDisplay}${extraEmojis}`;
  }

  public async generateEmbed(): Promise<EmbedBuilder> {
    try {
      const config = ConfigManager.getConfig();
      const seasonNumber = config.season;
      const season = await prismaClient.season.findUnique({
        where: { number: seasonNumber },
      });

      if (!season) {
        throw new Error(
          `Season with number=${seasonNumber} not found. Please create it first.`
        );
      }

      const topTenPlayerStats = await prismaClient.playerStats.findMany({
        where: { seasonId: season.id },
        orderBy: { elo: "desc" },
        take: 10,
        include: {
          player: {
            select: { latestIGN: true },
          },
        },
      });

      const topTen = topTenPlayerStats.map((stats, index) => {
        const wins = stats.wins;
        const losses = stats.losses;
        return {
          rank: index + 1,
          ign: stats.player?.latestIGN ?? "N/A",
          elo: stats.elo,
          wins,
          losses,
          winLossRatio: losses > 0 ? wins / losses : wins,
          winStreak: stats.winStreak,
          loseStreak: stats.loseStreak,
        };
      });

      const embed = new EmbedBuilder()
        .setColor("#FFD700")
        .setTitle("🏆 Friendly Wars Leaderboards 🏆")
        .setDescription(`Top rated players for Season ${seasonNumber}!`)
        .setTimestamp();

      topTen.forEach((player) => {
        embed.addFields({
          name: this.getLeaderboardEntryString(
            player.rank,
            player.ign,
            player.elo,
            player.winLossRatio,
            player.wins,
            player.losses,
            player.winStreak,
            player.loseStreak
          ),
          value: "\u200b",
          inline: false,
        });
      });

      return embed;
    } catch (error) {
      console.error("Error generating leaderboard feed:", error);
      throw new Error("Failed to generate leaderboard feed.");
    }
  }
}
