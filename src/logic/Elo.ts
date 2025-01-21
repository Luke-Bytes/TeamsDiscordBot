import { EloUtil } from "../util/EloUtil";
import { ConfigManager } from "../ConfigManager";
import { PlayerInstance } from "../database/PlayerInstance";
import { CurrentGameManager } from "../logic/CurrentGameManager";

export class Elo {
  public calculateNewElo(player: PlayerInstance): number {
    const config = ConfigManager.getConfig();
    const game = CurrentGameManager.getCurrentGame();

    if (!game || !player) {
      console.error("Game or Player not found.");
      return player.elo;
    }

    let currentElo = player.elo;
    console.log(
      `Calculating Elo for ${player.ignUsed} (K = ${EloUtil.getKFactor(player.elo)})| Starting Elo: ${currentElo}`
    );

    const playerTeam = game.getPlayersTeam(player);

    if (!playerTeam || playerTeam === "UNDECIDED") {
      console.warn(`Player team is undecided for ${player.ignUsed}.`);
      return currentElo;
    }

    if (game.gameWinner && playerTeam === game.gameWinner) {
      let winEloGain = EloUtil.calculateEloChange(game, player, true);
      currentElo += winEloGain;
      console.log(`Win bonus applied to ${player.ignUsed}: +${winEloGain}`);
    } else if (game.gameWinner) {
      let loseEloLoss = EloUtil.calculateEloChange(game, player, false);
      currentElo -= loseEloLoss;
      console.log(`Loss penalty applied to ${player.ignUsed}: -${loseEloLoss}`);
    }

    if (
      (playerTeam === "BLUE" && game.MVPPlayerBlue === player.ignUsed) ||
      (playerTeam === "RED" && game.MVPPlayerRed === player.ignUsed)
    ) {
      currentElo += config.mvpBonus;
      console.log(
        `MVP bonus applied to ${player.ignUsed}: +${config.mvpBonus}`
      );
    }

    const captain = game.getCaptainOfTeam(playerTeam);
    if (captain?.discordSnowflake === player.discordSnowflake) {
      currentElo += config.captainBonus;
      console.log(
        `Captain bonus applied to ${player.ignUsed}: +${config.captainBonus}`
      );
    }

    console.log(
      `${player.ignUsed} | Before: ${player.elo} | After: ${currentElo}`
    );
    return currentElo;
  }

  public applyEloUpdate(player: PlayerInstance): void {
    player.elo = this.calculateNewElo(player);
    console.log(`Elo updated for ${player.ignUsed}: ${player.elo}`);
  }

  public static calculateMeanEloAndExpectedScore(teams: {
    RED: PlayerInstance[];
    BLUE: PlayerInstance[];
  }): {
    blueMeanElo: number;
    redMeanElo: number;
    blueExpectedScore: number;
    redExpectedScore: number;
  } {
    const blueMeanElo = EloUtil.calculateMeanElo(teams.BLUE);
    const redMeanElo = EloUtil.calculateMeanElo(teams.RED);
    const [blueExpectedScore, redExpectedScore] =
      EloUtil.calculateExpectedScore(blueMeanElo, redMeanElo);

    console.log(`[ELO] Calculated mean ELO and expected scores.`);
    console.log(
      `[ELO] Blue Mean Elo = ${blueMeanElo} | Red Mean Elo = ${redMeanElo}`
    );
    console.log(
      `[ELO] Blue Expected Score = ${blueExpectedScore} | Red Expected Score = ${redExpectedScore}`
    );

    return {
      blueMeanElo,
      redMeanElo,
      blueExpectedScore,
      redExpectedScore,
    };
  }
}
