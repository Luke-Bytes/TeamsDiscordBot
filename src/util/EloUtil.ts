import { GameInstance } from "../database/GameInstance";
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

const kFactorRanges = {
  0: 50,
  1300: 40,
  1600: 30,
  1900: 20,
  2200: 10,
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

  getKFactor(elo: number) {
    const sortedKFactors = Object.keys(kFactorRanges)
      .map(Number)
      .sort((a, b) => b - a);
    for (let i = 0; i < sortedKFactors.length; i++) {
      if (elo >= sortedKFactors[i]) {
        return kFactorRanges[sortedKFactors[i] as keyof typeof kFactorRanges];
      }
    }
    return kFactorRanges[
      sortedKFactors[sortedKFactors.length - 1] as keyof typeof kFactorRanges
    ];
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

  calculateExpectedScore(
    blueMeanElo: number,
    redMeanElo: number
  ): [number, number] {
    const blueExpectedScore = Number(
      (1 / (1 + Math.pow(10, (redMeanElo - blueMeanElo) / 400))).toFixed(2)
    );
    const redExpectedScore = Number((1 - blueExpectedScore).toFixed(2));
    return [blueExpectedScore, redExpectedScore];
  },

  calculateEloChange(
    game: GameInstance,
    player: PlayerInstance,
    isWin: boolean
  ) {
    const kFactor = this.getKFactor(player.elo);
    const expectedScore =
      game.getPlayersTeam(player) === "BLUE"
        ? game.blueExpectedScore
        : game.redExpectedScore;
    let eloChange = 0;
    if (expectedScore !== undefined) {
      const actualScore = isWin ? 1 : 0;
      eloChange = Math.abs(kFactor * (actualScore - expectedScore));

      if (player.winStreak >= 3 && isWin) {
        if (player.winStreak > 5 && player.winStreak <= 10)
          eloChange *= 1.3 + (player.winStreak - 5) * 0.05;
        else eloChange *= 1 + (player.winStreak - 2) * 0.1;
        console.log(
          `Win streak detected! (${player.winStreak}) Applying bonus Elo.`
        );
      }
    }
    return Number(eloChange.toFixed(1));
  },
};
