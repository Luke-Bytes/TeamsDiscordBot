import { GameInstance } from "../database/GameInstance.js";
import { DiscordUtil } from "../util/DiscordUtil";
import { ConfigManager } from "../ConfigManager";
import { Guild } from "discord.js";
import { gameFeed } from "../logic/gameFeed/GameFeed";

export class CurrentGameManager {
  private static currentGame?: GameInstance;
  static pollCloseTimeout?: NodeJS.Timeout;
  public static getCurrentGame() {
    if (!this.currentGame) {
      this.currentGame = GameInstance.getInstance();
    }
    return this.currentGame;
  }

  public static resetCurrentGame() {
    this.currentGame?.reset();
  }

  public static async cancelCurrentGame(guild: Guild) {
    const config = ConfigManager.getConfig();
    this.currentGame?.mapVoteManager?.cancelVote();
    this.currentGame?.minerushVoteManager?.cancelVote();
    const chatChannelIds = [config.channels.gameFeed];
    gameFeed.removeAllFeedMessages();
    try {
      await DiscordUtil.cleanUpAllChannelMessages(guild, chatChannelIds);
    } catch (error) {
      console.error("Failed to clean up messages:", error);
    }
    this.resetCurrentGame();
  }

  public static schedulePollCloseTime(startTime: Date) {
    if (this.pollCloseTimeout) {
      clearTimeout(this.pollCloseTimeout);
    }

    const pollCloseTime = new Date(startTime.getTime() - 5 * 60 * 1000);
    const delay = pollCloseTime.getTime() - Date.now();

    if (delay > 0) {
      this.pollCloseTimeout = setTimeout(() => {
        this.getCurrentGame().stopVoting();
        console.log(
          "Poll has been stopped automatically without deleting messages."
        );
      }, delay);
    } else {
      console.warn("Poll close time is in the past. Skipping scheduling.");
    }
  }
}
