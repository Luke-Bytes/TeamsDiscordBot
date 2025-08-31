import { GameInstance } from "../database/GameInstance";
import { DiscordUtil } from "../util/DiscordUtil";
import { ConfigManager } from "../ConfigManager";
import { Guild, EmbedBuilder } from "discord.js";
import { gameFeed } from "../logic/gameFeed/GameFeed";
import { prettifyName } from "../util/Utils";
import TeamCommand from "../commands/TeamCommand";
import { DraftTeamPickingSession } from "./teams/DraftTeamPickingSession";
import { PermissionsUtil } from "../util/PermissionsUtil";

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
    this.currentGame?.reset();
    this.clearClassBanTimers();
    this.clearCaptainTimers();
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
      const both = banned.filter(
        (c) => !byTeam.RED.includes(c) && !byTeam.BLUE.includes(c)
      );
      const redOnly = byTeam.RED.filter((c) => !both.includes(c));
      const blueOnly = byTeam.BLUE.filter((c) => !both.includes(c));
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

          // Clear any existing single captain as per rules
          for (const t of ["RED", "BLUE"] as const) {
            const c = game.getCaptainOfTeam(t);
            if (c) {
              c.captain = false;
              // Remove captain role
              await guild.members
                .fetch(c.discordSnowflake)
                .then((m) =>
                  m.roles.remove(PermissionsUtil.config.roles.captainRole)
                )
                .catch(() => {});
            }
          }

          // Eligible players: registered, elo > 1000, presence in online/idle/dnd
          const players = game.getPlayers();
          const presenceOk = new Set(["online", "idle", "dnd"]);
          const eligible: { p: any; elo: number }[] = [];
          for (const p of players) {
            if ((p.elo ?? 0) <= 1000) continue;
            const m = await guild.members
              .fetch(p.discordSnowflake)
              .catch(() => undefined as any);
            const status = (m?.presence?.status as string) || "offline";
            if (!presenceOk.has(status)) continue;
            eligible.push({ p, elo: p.elo ?? 1000 });
          }

          if (eligible.length < 2) {
            await DiscordUtil.sendMessage(
              "gameFeed",
              "Could not find enough eligible players for captains. Organisers, please set captains manually."
            );
            return;
          }

          // Pick first captain randomly
          const first = eligible[Math.floor(Math.random() * eligible.length)];
          // Pick second: nearest higher elo
          const rest = eligible.filter((e) => e.p !== first.p);
          let higher = rest
            .filter((e) => e.elo >= first.elo)
            .sort((a, b) => a.elo - b.elo);
          let second =
            higher[0] ||
            rest.sort(
              (a, b) =>
                Math.abs(a.elo - first.elo) - Math.abs(b.elo - first.elo)
            )[0];

          const assignCaptain = async (team: "RED" | "BLUE", player: any) => {
            const res = game.setTeamCaptain(team, player);
            if (res.oldCaptain) {
              await guild.members
                .fetch(res.oldCaptain)
                .then((oldM) =>
                  oldM.roles.remove(PermissionsUtil.config.roles.captainRole)
                )
                .catch(() => undefined);
            }
            await guild.members
              .fetch(player.discordSnowflake)
              .then(async (m) => {
                await m.roles.add(PermissionsUtil.config.roles.captainRole);
                if (team === "RED") {
                  await m.roles.add(PermissionsUtil.config.roles.redTeamRole);
                  await m.roles.remove(
                    PermissionsUtil.config.roles.blueTeamRole
                  );
                } else {
                  await m.roles.add(PermissionsUtil.config.roles.blueTeamRole);
                  await m.roles.remove(
                    PermissionsUtil.config.roles.redTeamRole
                  );
                }
              })
              .catch(() => undefined);
          };

          await assignCaptain("BLUE", first.p);
          await assignCaptain("RED", second.p);

          await DiscordUtil.sendMessage(
            "gameFeed",
            `Captains have been auto-selected: BLUE - ${first.p.ignUsed}, RED - ${second.p.ignUsed}.`
          );

          // Auto-start draft team picking
          try {
            const fakeInteraction: any = {
              editReply: async (_: any) => {},
              guild,
            };
            const session = new DraftTeamPickingSession();
            await session.initialize(fakeInteraction);
            if (TeamCommand.instance) {
              TeamCommand.instance.teamPickingSession = session;
            }
          } catch (e) {
            console.error("Failed to auto-start draft team picking:", e);
          }
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
