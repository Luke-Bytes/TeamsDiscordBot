import { GameInstance } from "database/GameInstance";

export class CurrentGameManager {
  private static currentGame?: GameInstance;

  private constructor() {}

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
