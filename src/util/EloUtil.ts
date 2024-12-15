//TODO add relevant emojis and change elo value cut offs
import { PlayerInstance } from "../database/PlayerInstance";

const eloEmojis = {
  800: ":black_circle:",
  1000: ":radio_button:",
  1100: ":star2:",
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
};
