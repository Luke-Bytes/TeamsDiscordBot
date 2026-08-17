import { EmbedBuilder } from "discord.js";
import { prismaClient } from "../../database/prismaClient";
import { EloUtil } from "../../util/EloUtil";
import { SeasonService } from "../../database/SeasonService";
import { escapeIgn } from "../../util/Utils";
import { SeasonType } from "@prisma/client";

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
    return `${rankEmoji} **${escapeIgn(ign)}** ${eloEmoji} ${elo} | W/L: ${winLossDisplay}${extraEmojis}`;
  }

  public async generateEmbed(): Promise<EmbedBuilder> {
    try {
      const season = await SeasonService.requireActiveSeason();
      const seasonNumber = season.number;

      const topTenPlayerStats = await prismaClient.playerStats.findMany({
        where: { seasonId: season.id },
        orderBy:
          season.type !== SeasonType.RELAXED
            ? { elo: "desc" }
            : [{ wins: "desc" }, { biggestWinStreak: "desc" }],
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
        .setColor(season.type !== SeasonType.RELAXED ? "#FFD700" : "#57F287")
        .setTitle(
          season.type !== SeasonType.RELAXED
            ? "🏆 Friendly Wars Leaderboards 🏆"
            : "🎉 Friendly Wars Activity Board"
        )
        .setDescription(
          season.type !== SeasonType.RELAXED
            ? `Top rated players for Season ${seasonNumber}!`
            : `Unranked activity highlights for Relaxed Season ${seasonNumber}.`
        )
        .setTimestamp();

      topTen.forEach((player) => {
        embed.addFields({
          name:
            season.type !== SeasonType.RELAXED
              ? this.getLeaderboardEntryString(
                  player.rank,
                  player.ign,
                  player.elo,
                  player.winLossRatio,
                  player.wins,
                  player.losses,
                  player.winStreak,
                  player.loseStreak
                )
              : `**${escapeIgn(player.ign)}** — ${player.wins + player.losses} games`,
          value:
            season.type !== SeasonType.RELAXED
              ? "\u200b"
              : `${player.wins} wins • ${player.losses} losses • current streak ${player.winStreak}`,
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
