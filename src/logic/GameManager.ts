import { TeamsGame } from "../database/TeamsGame";

//todo bad naming
export class GameManager {
  private static currentGame?: TeamsGame;

  private constructor() {}

  public static getGame() {
    if (!this.currentGame) {
      this.currentGame = new TeamsGame();
    }
    return this.currentGame;
  }

  public static resetGame() {
    this.currentGame = new TeamsGame();
  }

  public static cancelGame() {
    this.currentGame?.mapVoteManager?.cancelVote();
    this.currentGame?.minerushVoteManager?.cancelVote();

    this.resetGame();
  }
}
