import { TeamsGame } from "database/TeamsGame";

export class GameManager {
  private static gameManager: GameManager;
  private currentGame?: TeamsGame;

  private constructor() {}

  public static getGameManager() {
    if (!this.gameManager) {
      this.gameManager = new GameManager();
    }
    return this.gameManager;
  }

  public getGame() {
    if (!this.currentGame) {
      this.currentGame = new TeamsGame();
    }
    return this.currentGame;
  }
}
