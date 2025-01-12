import { PlayerInstance } from "../database/PlayerInstance";

const eloEmojis = {
  800: ":pirate_flag:",
  900: ":black_circle:",
  1000: ":white_circle:",
  1100: ":star:",
  1200: ":gem:",
  1300: ":radioactive:",
  1400: ":cold_face:",
  1500: ":trophy:",
};

export const EloUtil = {
  getEloEmoji(elo: number) {
    const sortedEloRanks = Object.keys(eloEmojis)
      .map(Number)
      .sort((a, b) => a - b);
    for (let i = sortedEloRanks.length - 1; i >= 0; i--) {
      if (elo >= sortedEloRanks[i]) {
        return eloEmojis[sortedEloRanks[i] as keyof typeof eloEmojis];
      }
    }

    return eloEmojis[sortedEloRanks[0] as keyof typeof eloEmojis];
  },

  getEloFormatted(player: PlayerInstance) {
    return `[${player.elo}]`;
  },

  calculateMeanElo(players: PlayerInstance[]) {
    if (players.length === 0) return 1000;
    const totalElo = players.reduce(
      (sum, player) => sum + (player.elo || 1000),
      0
    );
    return Math.round(totalElo / players.length);
  },
};
