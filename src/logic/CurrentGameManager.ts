import { TeamsGame } from "../database/TeamsGame";

//todo bad naming
export class CurrentGameManager {
  private static currentGame?: TeamsGame;

  private constructor() {}

  public static getCurrentGame() {
    if (!this.currentGame) {
      this.currentGame = new TeamsGame();
    }
    return this.currentGame;
  }

  public static resetCurrentGame() {
    this.currentGame = new TeamsGame();
  }

  public static cancelCurrentGame() {
    this.currentGame?.mapVoteManager?.cancelVote();
    this.currentGame?.minerushVoteManager?.cancelVote();

    this.resetCurrentGame();
  }
}
