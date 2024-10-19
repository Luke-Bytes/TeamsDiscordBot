import { GameInstance } from "../database/GameInstance";

//todo bad naming
export class CurrentGameManager {
  private static currentGame?: GameInstance;

  private constructor() {}

  public static getCurrentGame() {
    if (!this.currentGame) {
      this.currentGame = new GameInstance();
    }
    return this.currentGame;
  }

  public static resetCurrentGame() {
    this.currentGame = new GameInstance();
  }

  public static cancelCurrentGame() {
    this.currentGame?.mapVoteManager?.cancelVote();
    this.currentGame?.minerushVoteManager?.cancelVote();

    this.resetCurrentGame();
  }
}
