import { GameInstance } from "../database/GameInstance";
import { DiscordUtil } from "../util/DiscordUtil";
import { ConfigManager } from "../ConfigManager";
import { Team } from "@prisma/client";
import { Guild, EmbedBuilder } from "discord.js";
import { gameFeed } from "../logic/gameFeed/GameFeed";
import { escapeIgn, escapeText, prettifyName } from "../util/Utils";
import TeamCommand from "../commands/TeamCommand";
import { AutoCaptainSelector } from "./AutoCaptainSelector";
import { Scheduler } from "../util/SchedulerUtil";
import CaptainPlanDMManager from "./CaptainPlanDMManager";
import { GameRecoveryCoordinator } from "./ActiveGameRecovery";

export class CurrentGameManager {
  private static currentGame?: GameInstance;
  static classBanWarningTimeout?: NodeJS.Timeout;
  static classBanDeadlineTimeout?: NodeJS.Timeout;
  static captainReminderTimeout?: NodeJS.Timeout;
  static captainEnforceTimeout?: NodeJS.Timeout;
  static draftAutoStartTimeout?: NodeJS.Timeout;
  public static getCurrentGame() {
    if (!this.currentGame) {
      this.currentGame = GameInstance.getInstance();
    }
    return this.currentGame;
  }

  public static async resetCurrentGame(): Promise<void> {
    // Cancel any ongoing votes/polls
    const game = this.getCurrentGame();
    Scheduler.cancel("mapVote");
    Scheduler.cancel("minerushVote");
    try {
      await game.mapVoteManager?.cancelVote();
    } catch (e) {
      console.warn("Failed to cancel map vote during reset:", e);
    }
    try {
      await game.minerushVoteManager?.cancelVote();
    } catch (e) {
      console.warn("Failed to cancel minerush vote during reset:", e);
    }

    // Clear any scheduled timers
    this.clearClassBanTimers();
    this.clearCaptainTimers();
    // Stop game feed updaters
    try {
      gameFeed.removeAllFeedMessages();
    } catch (e) {
      void e; // intentionally ignore cleanup errors
    }

    // Reset any active team picking session
    try {
      await TeamCommand.instance?.resetTeamPickingSession();
    } catch (e) {
      void e;
    }

    // Reset any captain plan DM sessions
    try {
      CaptainPlanDMManager.resetAllInstances();
    } catch (e) {
      void e;
    }

    // Finally, reset the in-memory game state
    game.reset();
  }

  public static async cancelCurrentGame(guild: Guild) {
    const config = ConfigManager.getConfig();
    const game = this.getCurrentGame();
    try {
      await game.mapVoteManager?.cancelVote();
    } catch {
      // ignore vote cleanup failures
    }
    try {
      await game.minerushVoteManager?.cancelVote();
    } catch {
      // ignore vote cleanup failures
    }
    this.clearClassBanTimers();
    this.clearCaptainTimers();
    const chatChannelIds = [config.channels.gameFeed];
    gameFeed.removeAllFeedMessages();
    try {
      await DiscordUtil.cleanUpAllChannelMessages(guild, chatChannelIds);
    } catch (error) {
      console.error("Failed to clean up messages:", error);
    }
    for (const message of [
      game.announcementPingMessage,
      game.announcementMessage,
      game.announcementPreviewMessage,
    ]) {
      if (typeof message?.delete === "function") {
        await message.delete().catch(() => {});
      }
    }
    game.announcementPingMessage = undefined;
    game.announcementMessage = undefined;
    game.announcementPreviewMessage = undefined;
    await this.resetCurrentGame();
  }

  public static scheduleClassBanTimers(): void {
    const game = this.getCurrentGame();
    if (!game.startTime) return;
    const token = game.getLifecycleToken();
    if (typeof game.getClassBanLimit !== "function") return;
    if (game.getClassBanLimit() <= 0) return;

    // Clear existing
    this.clearClassBanTimers();

    const warningTime = new Date(game.startTime.getTime() - 60 * 1000);
    const now = Date.now();

    if (warningTime.getTime() > now) {
      const sendClassBanWarning = async () => {
        const done = GameRecoveryCoordinator.enterOperation();
        if (!done) {
          GameRecoveryCoordinator.deferUntilCaptureAborts(() => { void sendClassBanWarning(); });
          return;
        }
        try {
          if (game.getLifecycleToken() !== token) return;
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
        } finally { done(); }
      };
      this.classBanWarningTimeout = setTimeout(sendClassBanWarning, warningTime.getTime() - now);
    }

    if (game.startTime.getTime() > now) {
      const enforceClassBan = async () => {
        const done = GameRecoveryCoordinator.enterOperation();
        if (!done) {
          GameRecoveryCoordinator.deferUntilCaptureAborts(() => { void enforceClassBan(); });
          return;
        }
        try {
          if (game.getLifecycleToken() !== token) return;
          await CurrentGameManager.enforceClassBanDeadline(token);
        } catch (e) {
          console.error("Error enforcing class ban deadline:", e);
        } finally { done(); }
      };
      this.classBanDeadlineTimeout = setTimeout(enforceClassBan, game.startTime.getTime() - now);
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

  public static async enforceClassBanDeadline(ownerToken?: string): Promise<void> {
    const game = this.getCurrentGame();
    if (ownerToken && (game.getLifecycleToken() !== ownerToken || GameRecoveryCoordinator.isFrozen())) return;
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
      const byTeam = game.settings.nonSharedCaptainBannedClasses ?? {
        [Team.RED]: [],
        [Team.BLUE]: [],
      };
      game.settings.nonSharedCaptainBannedClasses = byTeam;
      const organiserBans = game.settings.organiserBannedClasses ?? [];
      const sharedCaptainBans = game.settings.sharedCaptainBannedClasses ?? [];
      let both: string[];
      let redOnly: string[];
      let blueOnly: string[];

      if (game.classBanMode === "shared") {
        // In shared mode, ALL bans are shared (organiser + any captain bans)
        const sharedSet = new Set([
          ...organiserBans,
          ...sharedCaptainBans,
          ...byTeam.RED,
          ...byTeam.BLUE,
        ]);
        both = Array.from(sharedSet);
        redOnly = [];
        blueOnly = [];
      } else {
        // Default behavior: organiser/shared captain bans + team-only bans
        const sharedSet = new Set([...organiserBans, ...sharedCaptainBans]);
        both = Array.from(sharedSet);
        redOnly = byTeam.RED.filter((c) => !sharedSet.has(c));
        blueOnly = byTeam.BLUE.filter((c) => !sharedSet.has(c));
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
      if (!ownerToken || (game.getLifecycleToken() === ownerToken && !GameRecoveryCoordinator.isFrozen())) {
        game.markClassBansAnnounced();
      }
    }
  }

  public static scheduleCaptainTimers(guild: Guild): void {
    const game = this.getCurrentGame();
    if (!game.startTime) return;
    const token = game.getLifecycleToken();
    this.clearCaptainTimers();
    // The rest of the logic has been moved to AutoCaptainSelector; keep timer scheduling here.

    const now = Date.now();
    const reminderTime = new Date(game.startTime.getTime() - 20 * 60 * 1000);
    const enforceTime = new Date(game.startTime.getTime() - 15 * 60 * 1000);

    if (reminderTime.getTime() > now) {
      const remindCaptains = async () => {
        const done = GameRecoveryCoordinator.enterOperation();
        if (!done) {
          GameRecoveryCoordinator.deferUntilCaptureAborts(() => { void remindCaptains(); });
          return;
        }
        try {
          if (game.getLifecycleToken() !== token || !game.announced ||
              game.getGameStartStatus() !== "idle" || game.isFinished) return;
          const redCap = game.getCaptainOfTeam("RED");
          const blueCap = game.getCaptainOfTeam("BLUE");
          const haveBoth = !!redCap && !!blueCap;
          if (haveBoth) return;
          await DiscordUtil.sendMessage(
            "gameFeed",
            "**Reminder**: Captains are still needed. If not set in time then two will be chosen at random."
          );
        } catch (e) {
          console.error("Error sending captain reminder:", e);
        } finally { done(); }
      };
      this.captainReminderTimeout = setTimeout(remindCaptains, reminderTime.getTime() - now);
    }

    if (enforceTime.getTime() > now) {
      const autoSelectCaptains = async () => {
        const done = GameRecoveryCoordinator.enterOperation();
        if (!done) {
          GameRecoveryCoordinator.deferUntilCaptureAborts(() => { void autoSelectCaptains(); });
          return;
        }
        try {
          if (this.getCurrentGame() !== game || game.getLifecycleToken() !== token ||
              !game.announced || game.getGameStartStatus() !== "idle" || game.isFinished) return;
          if (await this.cancelForLowRegistrationAtAutomaticStart(guild)) {
            return;
          }

          if (game.getLifecycleToken() !== token || !game.announced ||
              game.getGameStartStatus() !== "idle") return;
          const redCap = game.getCaptainOfTeam("RED");
          const blueCap = game.getCaptainOfTeam("BLUE");
          const haveBoth = !!redCap && !!blueCap;
          if (haveBoth) {
            await this.attemptAutoStartDraft(guild);
            return;
          }

          const teamCommand = TeamCommand.instance;
          const result = teamCommand
            ? await teamCommand.runRosterOperation(() =>
                AutoCaptainSelector.randomiseCaptains(guild, false)
              )
            : await AutoCaptainSelector.randomiseCaptains(guild, false);
          if ("error" in result) {
            await DiscordUtil.sendMessage("gameFeed", result.error);
            return;
          }
          await DiscordUtil.sendMessage(
            "gameFeed",
            `Captains have been auto-selected: BLUE - ${escapeIgn(
              result.blue.ignUsed ?? "Unknown"
            )}, RED - ${escapeIgn(result.red.ignUsed ?? "Unknown")}.`
          );
          await this.attemptAutoStartDraft(guild);
        } catch (e) {
          console.error("Error enforcing auto-captain selection:", e);
        } finally { done(); }
      };
      this.captainEnforceTimeout = setTimeout(autoSelectCaptains, enforceTime.getTime() - now);
    }
  }

  private static async cancelForLowRegistrationAtAutomaticStart(
    guild: Guild
  ): Promise<boolean> {
    const game = this.getCurrentGame();
    if (!game.announced) {
      return false;
    }

    const registeredPlayerCount = game.getRegisteredPlayerCount();
    if (!game.shouldAutoCancelForLowRegistration()) {
      return false;
    }

    await this.cancelCurrentGame(guild);

    const cancelMessage = `⚠️ The announced game has been automatically cancelled because only ${registeredPlayerCount} players were registered at the automatic start time. A minimum of ${GameInstance.MIN_AUTO_START_REGISTERED_COUNT} registered players is required 15 minutes before the announced start time.`;
    await DiscordUtil.sendMessage("gameFeed", cancelMessage);
    await DiscordUtil.sendMessage("registration", cancelMessage);
    return true;
  }

  public static async attemptAutoStartDraft(guild: Guild): Promise<void> {
    const game = this.getCurrentGame();
    const token = game.getLifecycleToken();
    const teamCommand = TeamCommand.instance;
    if (!teamCommand || teamCommand.isTeamPickingSessionActive()) return;
    if (game.teamsDecidedBy) return;

    const redCap = game.getCaptainOfTeam("RED");
    const blueCap = game.getCaptainOfTeam("BLUE");
    if (!redCap || !blueCap) return;

    const startDraft = async () => {
      try {
        const started = await teamCommand.startAutomaticDraft(guild);
        if (!started) {
          console.warn("Automatic draft not started; roster, captains or lifecycle changed.");
        }
      } catch (error) {
        console.error("Failed to auto-start draft team picking:", error);
      }
    };

    const undecidedCount = game.getPlayersOfTeam("UNDECIDED").length;
    if (undecidedCount % 2 === 0) {
      await startDraft();
      return;
    }

    await DiscordUtil.sendMessage(
      "registration",
      "⚠️ Registered players are uneven. Waiting 1 minute for another player to register; otherwise the last registered player will be removed and team picking will start."
    );

    if (this.draftAutoStartTimeout) {
      clearTimeout(this.draftAutoStartTimeout);
    }
    const startDelayedDraft = async () => {
      const done = GameRecoveryCoordinator.enterOperation();
      if (!done) {
        GameRecoveryCoordinator.deferUntilCaptureAborts(() => { void startDelayedDraft(); });
        return;
      }
      try {
      const currentGame = this.getCurrentGame();
      if (currentGame !== game || game.getLifecycleToken() !== token ||
          !game.announced || game.isFinished ||
          game.getGameStartStatus() !== "idle") return;
      if (teamCommand.isTeamPickingSessionActive()) return;
      if (currentGame.teamsDecidedBy) return;

      const red = currentGame.getCaptainOfTeam("RED");
      const blue = currentGame.getCaptainOfTeam("BLUE");
      if (!red || !blue) return;

      const undecided = currentGame.getPlayersOfTeam("UNDECIDED");
      if (undecided.length % 2 === 0) {
        await startDraft();
        return;
      }

      const removalId = this.getAutoBalanceRemovalId(currentGame);
      if (!removalId) {
        await DiscordUtil.sendMessage(
          "registration",
          "Unable to auto-balance teams to start picking. Please unregister a player manually."
        );
        return;
      }

      const removedPlayer = currentGame
        .getPlayers()
        .find((p) => p.discordSnowflake === removalId);
      const removedName = escapeText(
        removedPlayer?.ignUsed ?? "Unknown Player"
      );

      const removed = await teamCommand.runRosterOperation(async () => {
        if (this.getCurrentGame() !== game || game.getLifecycleToken() !== token ||
            !game.announced || game.getGameStartStatus() !== "idle" || game.isFinished ||
            teamCommand.isTeamPickingSessionActive() || game.teamsDecidedBy ||
            game.getPlayersOfTeam("UNDECIDED").length % 2 === 0 ||
            !game.getPlayers().some((p) => p.discordSnowflake === removalId)) return false;
        await currentGame.removePlayerByDiscordId(removalId);
        return true;
      });
      if (!removed) return;
      await DiscordUtil.sendMessage(
        "registration",
        `Teams must be even to start picking. <@${removalId}> (${removedName}) was the last to register and has been removed. You may re-register if another player joins.`
      );

      await startDraft();
      } finally { done(); }
    };
    this.draftAutoStartTimeout = setTimeout(startDelayedDraft, 60_000);
  }

  private static getAutoBalanceRemovalId(game: GameInstance): string | null {
    const isCaptain = (id: string) =>
      game.getCaptainOfTeam("RED")?.discordSnowflake === id ||
      game.getCaptainOfTeam("BLUE")?.discordSnowflake === id;

    const last = game.lastRegisteredSnowflake;
    if (
      last &&
      !isCaptain(last) &&
      game.getPlayers().some((p) => p.discordSnowflake === last)
    ) {
      return last;
    }

    const undecided = [...game.getPlayersOfTeam("UNDECIDED")].reverse();
    const fallback = undecided.find((p) => !isCaptain(p.discordSnowflake));
    return fallback?.discordSnowflake ?? null;
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
    if (this.draftAutoStartTimeout) {
      clearTimeout(this.draftAutoStartTimeout);
      this.draftAutoStartTimeout = undefined;
    }
  }
}
