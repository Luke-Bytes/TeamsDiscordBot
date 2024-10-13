import { TeamsGame } from "database/TeamsGame";

export class GameManager {
  private static currentGame?: TeamsGame;

  private constructor() {}

  public static getGame() {
    if (!this.currentGame) {
      this.currentGame = new TeamsGame();
    }
    return this.currentGame;
  }
}
