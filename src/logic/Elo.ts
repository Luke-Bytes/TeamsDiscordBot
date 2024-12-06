import { ConfigManager } from "../ConfigManager.js";
import { PlayerInstance } from "../database/PlayerInstance.js";

export class Elo {
  private won: boolean;
  private mvp: boolean;

  constructor(won: boolean, mvp: boolean) {
    this.won = won;
    this.mvp = mvp;
  }

  public calculateNewElo(player: PlayerInstance): number {
    const config = ConfigManager.getConfig();
    let currentElo = player.elo;
    if (this.won) {
      currentElo += config.winEloGain;
    } else {
      currentElo -= config.loseEloLoss;
    }

    if (this.mvp) {
      currentElo += config.mvpBonus;
    }

    return currentElo;
  }

  public applyEloUpdate(player: PlayerInstance): void {
    const newElo = this.calculateNewElo(player);
    player.elo = newElo;
  }
}
