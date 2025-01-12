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
      `Calculating Elo for ${player.ignUsed} | Starting Elo: ${currentElo}`
    );

    const playerTeam = game.getPlayersTeam(player);

    if (!playerTeam || playerTeam === "UNDECIDED") {
      console.warn(`Player team is undecided for ${player.ignUsed}.`);
      return currentElo;
    }

    if (game.gameWinner && playerTeam === game.gameWinner) {
      currentElo += config.winEloGain;
      console.log(
        `Win bonus applied to ${player.ignUsed}: +${config.winEloGain}`
      );
    } else if (game.gameWinner) {
      currentElo -= config.loseEloLoss;
      console.log(
        `Loss penalty applied to ${player.ignUsed}: -${config.loseEloLoss}`
      );
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
}
