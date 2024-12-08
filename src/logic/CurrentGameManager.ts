import { GameInstance } from "../database/GameInstance.js";

export class CurrentGameManager {
  private static currentGame?: GameInstance;
  public static getCurrentGame() {
    if (!this.currentGame) {
      this.currentGame = GameInstance.getInstance();
    }
    return this.currentGame;
  }

  public static resetCurrentGame() {
    this.currentGame?.reset();
  }

  public static cancelCurrentGame() {
    this.currentGame?.mapVoteManager?.cancelVote();
    this.currentGame?.minerushVoteManager?.cancelVote();
    this.resetCurrentGame();
  }
}
