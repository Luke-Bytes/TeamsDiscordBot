import { GameInstance } from "../database/GameInstance";
import { DiscordUtil } from "../util/DiscordUtil";
import { ConfigManager } from "../ConfigManager";
import { Guild, EmbedBuilder } from "discord.js";
import { gameFeed } from "../logic/gameFeed/GameFeed";
import { prettifyName } from "../util/Utils";
import TeamCommand from "../commands/TeamCommand";
import { DraftTeamPickingSession } from "./teams/DraftTeamPickingSession";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { AutoCaptainSelector } from "./AutoCaptainSelector";

export class CurrentGameManager {
  private static currentGame?: GameInstance;
  static pollCloseTimeout?: NodeJS.Timeout;
  static classBanWarningTimeout?: NodeJS.Timeout;
  static classBanDeadlineTimeout?: NodeJS.Timeout;
  static captainReminderTimeout?: NodeJS.Timeout;
  static captainEnforceTimeout?: NodeJS.Timeout;
  public static getCurrentGame() {
    if (!this.currentGame) {
      this.currentGame = GameInstance.getInstance();
    }
    return this.currentGame;
  }

  public static resetCurrentGame() {
    // Cancel any ongoing votes/polls
    this.currentGame?.mapVoteManager?.cancelVote();
    this.currentGame?.minerushVoteManager?.cancelVote();

    // Clear any scheduled timers
    this.clearClassBanTimers();
    this.clearCaptainTimers();
    if (this.pollCloseTimeout) {
      clearTimeout(this.pollCloseTimeout);
      this.pollCloseTimeout = undefined;
    }

    // Stop game feed updaters
    try {
      gameFeed.removeAllFeedMessages();
    } catch (e) {
      void e; // intentionally ignore cleanup errors
    }

    // Reset any active team picking session
    try {
      TeamCommand.instance?.resetTeamPickingSession();
    } catch (e) {
      void e;
    }

    // Finally, reset the in-memory game state
    this.currentGame?.reset();
  }

  public static async cancelCurrentGame(guild: Guild) {
    const config = ConfigManager.getConfig();
    this.currentGame?.mapVoteManager?.cancelVote();
    this.currentGame?.minerushVoteManager?.cancelVote();
    this.clearClassBanTimers();
    this.clearCaptainTimers();
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

  public static scheduleClassBanTimers(): void {
    const game = this.getCurrentGame();
    if (!game.startTime) return;
    if (typeof game.getClassBanLimit !== "function") return;
    if (game.getClassBanLimit() <= 0) return;

    // Clear existing
    this.clearClassBanTimers();

    const warningTime = new Date(game.startTime.getTime() - 60 * 1000);
    const now = Date.now();

    if (warningTime.getTime() > now) {
      this.classBanWarningTimeout = setTimeout(async () => {
        try {
          const redCaptain = game.getCaptainOfTeam("RED");
          const blueCaptain = game.getCaptainOfTeam("BLUE");
          if (
            redCaptain &&
            game.getCaptainBanCount(redCaptain.discordSnowflake) < 1
          ) {
            await DiscordUtil.sendMessage(
              "redTeamChat",
              "**Last-minute reminder:** Red Captain has not banned a class yet. Use `/class ban <class>` before the game starts."
            );
          }
          if (
            blueCaptain &&
            game.getCaptainBanCount(blueCaptain.discordSnowflake) < 1
          ) {
            await DiscordUtil.sendMessage(
              "blueTeamChat",
              "**Last-minute reminder:** Blue Captain has not banned a class yet. Use `/class ban <class>` before the game starts."
            );
          }
        } catch (e) {
          console.error("Error sending class ban reminders:", e);
        }
      }, warningTime.getTime() - now);
    }

    if (game.startTime.getTime() > now) {
      this.classBanDeadlineTimeout = setTimeout(async () => {
        try {
          await CurrentGameManager.enforceClassBanDeadline();
        } catch (e) {
          console.error("Error enforcing class ban deadline:", e);
        }
      }, game.startTime.getTime() - now);
    }
  }

  private static clearClassBanTimers() {
    if (this.classBanWarningTimeout) {
      clearTimeout(this.classBanWarningTimeout);
      this.classBanWarningTimeout = undefined;
    }
    if (this.classBanDeadlineTimeout) {
      clearTimeout(this.classBanDeadlineTimeout);
      this.classBanDeadlineTimeout = undefined;
    }
  }

  public static async enforceClassBanDeadline(): Promise<void> {
    const game = this.getCurrentGame();
    const redCaptain = game.getCaptainOfTeam("RED");
    const blueCaptain = game.getCaptainOfTeam("BLUE");
    const perCapLimit = game.getPerCaptainBanLimit();
    if (
      redCaptain &&
      game.getCaptainBanCount(redCaptain.discordSnowflake) < perCapLimit
    ) {
      game.lockCaptainBan(redCaptain.discordSnowflake);
      await DiscordUtil.sendMessage(
        "redTeamChat",
        "The class ban window has **closed**. You can no longer ban a class."
      );
    }
    if (
      blueCaptain &&
      game.getCaptainBanCount(blueCaptain.discordSnowflake) < perCapLimit
    ) {
      game.lockCaptainBan(blueCaptain.discordSnowflake);
      await DiscordUtil.sendMessage(
        "blueTeamChat",
        "The class ban window has **closed**. You can no longer ban a class."
      );
    }

    if (game.getClassBanLimit() > 0 && !game.areClassBansAnnounced()) {
      const byTeam = game.settings.bannedClassesByTeam;
      const banned = game.settings.bannedClasses;
      let both: string[];
      let redOnly: string[];
      let blueOnly: string[];

      if (game.classBanMode === "shared") {
        // In shared mode, ALL bans are shared (organiser + any captain bans)
        const sharedSet = new Set([...banned, ...byTeam.RED, ...byTeam.BLUE]);
        both = Array.from(sharedSet);
        redOnly = [];
        blueOnly = [];
      } else {
        // Default behavior: organiser shared bans + team-only bans
        both = banned.filter(
          (c) => !byTeam.RED.includes(c) && !byTeam.BLUE.includes(c)
        );
        redOnly = byTeam.RED.filter((c) => !both.includes(c));
        blueOnly = byTeam.BLUE.filter((c) => !both.includes(c));
      }
      const lockedEmbed = new EmbedBuilder()
        .setColor("DarkRed")
        .setTitle("❌ Class Bans Locked In")
        .addFields(
          {
            name: "🟨 Shared Bans",
            value: both.length ? both.map(prettifyName).join("\n") : "None",
            inline: true,
          },
          {
            name: "🔴 Red Can't Use",
            value: redOnly.length
              ? redOnly.map(prettifyName).join("\n")
              : "None",
            inline: true,
          },
          {
            name: "🔵 Blue Can't Use",
            value: blueOnly.length
              ? blueOnly.map(prettifyName).join("\n")
              : "None",
            inline: true,
          }
        )
        .setTimestamp();
      await DiscordUtil.sendMessage("gameFeed", { embeds: [lockedEmbed] });
      await DiscordUtil.sendMessage("redTeamChat", { embeds: [lockedEmbed] });
      await DiscordUtil.sendMessage("blueTeamChat", { embeds: [lockedEmbed] });
      game.markClassBansAnnounced();
    }
  }

  public static scheduleCaptainTimers(guild: Guild): void {
    const game = this.getCurrentGame();
    if (!game.startTime) return;
    this.clearCaptainTimers();
    // The rest of the logic has been moved to AutoCaptainSelector; keep timer scheduling here.

    const now = Date.now();
    const reminderTime = new Date(game.startTime.getTime() - 20 * 60 * 1000);
    const enforceTime = new Date(game.startTime.getTime() - 15 * 60 * 1000);

    if (reminderTime.getTime() > now) {
      this.captainReminderTimeout = setTimeout(async () => {
        try {
          await DiscordUtil.sendMessage(
            "gameFeed",
            "**Reminder**: Captains are still needed. If not set in time then two will be chosen at random."
          );
        } catch (e) {
          console.error("Error sending captain reminder:", e);
        }
      }, reminderTime.getTime() - now);
    }

    if (enforceTime.getTime() > now) {
      this.captainEnforceTimeout = setTimeout(async () => {
        try {
          const redCap = game.getCaptainOfTeam("RED");
          const blueCap = game.getCaptainOfTeam("BLUE");
          const haveBoth = !!redCap && !!blueCap;
          if (haveBoth) return;

          const result = await AutoCaptainSelector.randomiseCaptains(
            guild,
            true
          );
          if ("error" in result) {
            await DiscordUtil.sendMessage("gameFeed", result.error);
            return;
          }
          await DiscordUtil.sendMessage(
            "gameFeed",
            `Captains have been auto-selected: BLUE - ${result.blue.ignUsed}, RED - ${result.red.ignUsed}.`
          );
        } catch (e) {
          console.error("Error enforcing auto-captain selection:", e);
        }
      }, enforceTime.getTime() - now);
    }
  }

  private static clearCaptainTimers() {
    if (this.captainReminderTimeout) {
      clearTimeout(this.captainReminderTimeout);
      this.captainReminderTimeout = undefined;
    }
    if (this.captainEnforceTimeout) {
      clearTimeout(this.captainEnforceTimeout);
      this.captainEnforceTimeout = undefined;
    }
  }
}
