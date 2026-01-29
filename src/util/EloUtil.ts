import { GameInstance } from "../database/GameInstance";
import { PlayerInstance } from "../database/PlayerInstance";
import { ConfigManager } from "../ConfigManager";

const eloEmojis = {
  800: ":skull_crossbones:",
  900: ":black_circle:",
  1000: ":white_circle:",
  1100: ":star:",
  1200: ":gem:",
  1300: ":radioactive:",
  1400: ":cold_face:",
  1500: ":trophy:",
};

const kFactorRanges = {
  800: 50,
  900: 45,
  1000: 40,
  1100: 35,
  1200: 30,
  1300: 25,
  1400: 20,
  1500: 15,
  1600: 10,
  1700: 5,
};

export const EloUtil = {
  WIN_STREAK_MIN: 3,
  WIN_STREAK_MEDIUM_THRESHOLD: 5,
  WIN_STREAK_MAX_THRESHOLD: 10,
  BONUS_MULTIPLIER_MEDIUM: 1.3,
  BONUS_MULTIPLIER_INCREMENT_HIGH: 0.05,
  BONUS_MULTIPLIER_INCREMENT_LOW: 0.1,

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
    for (const element of sortedKFactors) {
      if (elo >= element) {
        return kFactorRanges[element as keyof typeof kFactorRanges];
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
  ): number {
    return this.getEloChangeBreakdown(game, player, isWin).finalChange;
  },

  getEloChangeBreakdown(
    game: GameInstance,
    player: PlayerInstance,
    isWin: boolean
  ): {
    kFactor: number;
    expectedScore: number;
    actualScore: number;
    baseChange: number;
    afterWinStreakChange: number;
    winStreakMultiplier: number;
    meanEloDifference: number;
    underdogWeightingApplied: boolean;
    underdogWeightFactor?: number;
    finalChange: number;
  } {
    const kFactor = this.getKFactor(player.elo);
    const expectedScore = this.getPlayerExpectedScore(game, player);
    if (expectedScore === undefined) {
      return {
        kFactor,
        expectedScore: 0,
        actualScore: isWin ? 1 : 0,
        baseChange: 0,
        afterWinStreakChange: 0,
        winStreakMultiplier: 1,
        meanEloDifference: 0,
        underdogWeightingApplied: false,
        finalChange: 0,
      };
    }

    const actualScore = isWin ? 1 : 0;
    const baseChange = Math.abs(kFactor * (actualScore - expectedScore));

    let winStreakMultiplier = 1;
    const afterWinStreakChange = this.applyWinStreakBonus(
      player,
      baseChange,
      isWin
    );
    if (baseChange > 0) {
      winStreakMultiplier = afterWinStreakChange / baseChange;
    }

    const meanEloDifference = Math.abs(
      (game.blueMeanElo ?? 0) - (game.redMeanElo ?? 0)
    );

    const underdogWeightingApplied = meanEloDifference >= 25;
    let finalChange = afterWinStreakChange;
    let underdogWeightFactor: number | undefined;
    if (underdogWeightingApplied) {
      underdogWeightFactor = ConfigManager.getConfig().underdogMultiplier;
      finalChange = this.applyUnderdogWeighting(
        finalChange,
        expectedScore,
        underdogWeightFactor,
        isWin
      );
      console.log(
        `Underdog weighting applied: ${afterWinStreakChange.toFixed(2)} -> ${finalChange.toFixed(2)} (factor ${underdogWeightFactor})`
      );
    }

    return {
      kFactor,
      expectedScore,
      actualScore,
      baseChange,
      afterWinStreakChange,
      winStreakMultiplier,
      meanEloDifference,
      underdogWeightingApplied,
      underdogWeightFactor,
      finalChange: Number(finalChange.toFixed(1)),
    };
  },

  getPlayerExpectedScore(
    game: GameInstance,
    player: PlayerInstance
  ): number | undefined {
    const team = game.getPlayersTeam(player);
    return team === "BLUE" ? game.blueExpectedScore : game.redExpectedScore;
  },

  applyWinStreakBonus(
    player: PlayerInstance,
    eloChange: number,
    isWin: boolean
  ): number {
    if (!isWin || player.winStreak < this.WIN_STREAK_MIN) return eloChange;

    const winStreak = Math.min(player.winStreak, this.WIN_STREAK_MAX_THRESHOLD);

    const bonusMultiplier =
      winStreak > this.WIN_STREAK_MEDIUM_THRESHOLD
        ? this.BONUS_MULTIPLIER_MEDIUM +
          (winStreak - this.WIN_STREAK_MEDIUM_THRESHOLD) *
            this.BONUS_MULTIPLIER_INCREMENT_HIGH
        : 1 +
          (winStreak - (this.WIN_STREAK_MIN - 1)) *
            this.BONUS_MULTIPLIER_INCREMENT_LOW;

    console.log(
      `${player.latestIGN} is on a (${player.winStreak}) win streak! Applying bonus Elo with multiplier: ${bonusMultiplier.toFixed(2)}`
    );
    return eloChange * bonusMultiplier;
  },

  applyUnderdogWeighting(
    eloChange: number,
    expectedScore: number,
    weightFactor: number,
    isWin: boolean
  ): number {
    if (expectedScore >= 0.4 && expectedScore <= 0.6) {
      return eloChange;
    }

    const adjustment = (0.5 - expectedScore) * weightFactor;
    const role = expectedScore > 0.5 ? "favoured" : "underdog";
    const difference = Math.abs(0.5 - expectedScore).toFixed(2);

    console.log(
      `Player is ${role} with expected score of ${expectedScore.toFixed(2)} (${role === "favoured" ? "+" : "-"}${difference}).`
    );

    return isWin
      ? eloChange + eloChange * adjustment
      : eloChange + eloChange * -adjustment;
  },
};
