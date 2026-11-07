import { ActivityType, Client, Message, TextBasedChannel } from "discord.js";
import {
  AnnouncementDeliveryState,
  Season,
  SeasonAnnouncementKind,
  SeasonClosureReason,
  SeasonLifecycleState,
  SeasonType,
} from "@prisma/client";
import { randomUUID } from "crypto";
import { prismaClient } from "./prismaClient";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { DiscordUtil } from "../util/DiscordUtil";
import { Channels } from "../Channels";
import { generateSeasonRecap } from "../logic/seasonRecap/SeasonRecap";
import { TitleService } from "../logic/TitleService";
import logger from "../util/Logger";

export type SeasonConfiguration = {
  gameLimit?: number | null;
  monthLimit?: number | null;
  currentType?: SeasonType;
  nextTypeOverride?: SeasonType | null;
  firstRolloverAt?: Date | null;
};

export type SeasonStatus = {
  season: Season;
  finishedGames: number;
  pendingAnnouncements: number;
};

const ANNOUNCEMENT_ORDER: SeasonAnnouncementKind[] = [
  SeasonAnnouncementKind.RECAP,
  SeasonAnnouncementKind.TITLES,
  SeasonAnnouncementKind.NEW_SEASON,
];

/** MongoDB is the sole authority for season selection and rollover state. */
export class SeasonService {
  private static client?: Client;
  private static deadlineTimer?: NodeJS.Timeout;
  private static periodicTimer?: NodeJS.Timeout;

  static async getActiveSeason(): Promise<Season | null> {
    return prismaClient.season.findFirst({
      where: { isActive: true },
      orderBy: { number: "desc" },
    });
  }

  static async requireActiveSeason(): Promise<Season> {
    const season = await this.getActiveSeason();
    if (!season)
      throw new Error("No active season found. Use /season start first.");
    return season;
  }

  static async getActiveSeasonNumber(): Promise<number> {
    return (await this.requireActiveSeason()).number;
  }

  static calculateDeadline(
    startDate: Date,
    monthLimit: number | null
  ): Date | null {
    if (!monthLimit) return null;
    const wholeMonths = Math.floor(monthLimit);
    const fraction = monthLimit - wholeMonths;
    const result = new Date(startDate);
    const originalDay = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + wholeMonths);
    const lastDay = new Date(
      Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
    ).getUTCDate();
    result.setUTCDate(Math.min(originalDay, lastDay));
    if (fraction) {
      const next = this.calculateDeadline(startDate, wholeMonths + 1)!;
      return new Date(
        result.getTime() + fraction * (next.getTime() - result.getTime())
      );
    }
    return result;
  }

  /** Configured limits always describe Ranked; Relaxed derives from that baseline. */
  static limitsForType(
    type: SeasonType,
    gameLimit: number | null,
    monthLimit: number | null
  ): { gameLimit: number | null; monthLimit: number | null } {
    return {
      gameLimit:
        gameLimit && type === SeasonType.RELAXED
          ? Math.max(1, Math.floor(gameLimit / 2))
          : gameLimit,
      monthLimit:
        monthLimit && type === SeasonType.RELAXED ? monthLimit / 2 : monthLimit,
    };
  }

  static async getStatus(): Promise<SeasonStatus> {
    const season = await this.requireActiveSeason();
    const [finishedGames, pendingAnnouncements] = await Promise.all([
      prismaClient.game.count({
        where: { seasonId: season.id, finished: true },
      }),
      prismaClient.seasonAnnouncement.count({
        where: { state: AnnouncementDeliveryState.PENDING },
      }),
    ]);
    return { season, finishedGames, pendingAnnouncements };
  }

  static async configure(configuration: SeasonConfiguration): Promise<Season> {
    const season = await this.requireActiveSeason();
    if (
      configuration.firstRolloverAt &&
      (!Number.isFinite(configuration.firstRolloverAt.getTime()) ||
        configuration.firstRolloverAt.getTime() <= Date.now())
    ) {
      throw new Error("The start date must be in the future.");
    }
    for (const [name, value] of [
      ["game limit", configuration.gameLimit],
      ["month limit", configuration.monthLimit],
    ] as const) {
      if (
        value !== undefined &&
        value !== null &&
        (!Number.isInteger(value) || value <= 0)
      ) {
        throw new Error(
          `${name} must be a positive whole number, or 0 to clear it.`
        );
      }
    }
    if (
      configuration.currentType &&
      configuration.currentType !== (season.type ?? SeasonType.RANKED)
    ) {
      const finishedGames = await prismaClient.game.count({
        where: { seasonId: season.id, finished: true },
      });
      if (finishedGames > 0) {
        throw new Error(
          "The current season type cannot change after a finished game."
        );
      }
    }

    const rankedGameLimit =
      configuration.gameLimit === undefined
        ? (season.rankedGameLimit ?? season.gameLimit)
        : configuration.gameLimit;
    const rankedMonthLimit =
      configuration.monthLimit === undefined
        ? (season.rankedMonthLimit ?? season.monthLimit)
        : configuration.monthLimit;
    const limits = this.limitsForType(
      configuration.currentType ?? season.type ?? SeasonType.RANKED,
      rankedGameLimit,
      rankedMonthLimit
    );
    const updated = await prismaClient.season.update({
      where: { id: season.id },
      data: {
        rankedGameLimit,
        rankedMonthLimit,
        ...limits,
        type: configuration.currentType,
        nextTypeOverride: configuration.nextTypeOverride,
        firstRolloverAt: configuration.firstRolloverAt,
        ...(configuration.firstRolloverAt !== undefined ||
        configuration.gameLimit !== undefined ||
        configuration.monthLimit !== undefined
          ? { rolloverPending: false, closureReason: null }
          : {}),
        rolloverDeadline: this.calculateDeadline(
          season.startDate,
          limits.monthLimit
        ),
      },
    });
    await this.evaluateRollover();
    await this.refreshPresence();
    const current = await this.getActiveSeason();
    if (current) this.scheduleDeadline(current);
    return updated;
  }

  static async bootstrap(
    type: SeasonType,
    requestedNumber?: number
  ): Promise<Season> {
    if (await this.getActiveSeason())
      throw new Error("An active season already exists.");
    const latest = await prismaClient.season.findFirst({
      orderBy: { number: "desc" },
    });
    const number = requestedNumber ?? (latest?.number ?? 0) + 1;
    if (number <= (latest?.number ?? 0)) {
      throw new Error(
        "A new season number must be higher than every historical season."
      );
    }
    const season = await prismaClient.season.create({
      data: {
        number,
        name: `Season ${number}`,
        startDate: new Date(),
        isActive: true,
        type,
        lifecycleState: SeasonLifecycleState.ACTIVE,
      },
    });
    await this.queueBlocks(season.id, SeasonAnnouncementKind.NEW_SEASON, [
      this.newSeasonMessage(season),
    ]);
    await this.deliverPendingAnnouncements();
    await this.refreshPresence();
    return season;
  }

  static async initialize(client: Client): Promise<void> {
    this.client = client;
    await this.recoverClosures();
    await this.evaluateRollover();
    await this.deliverPendingAnnouncements();
    await this.refreshPresence();
    const active = await this.getActiveSeason();
    if (active) this.scheduleDeadline(active);
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = setInterval(
      () => {
        void this.periodicMaintenance();
      },
      15 * 60 * 1000
    );
  }

  private static async periodicMaintenance(): Promise<void> {
    try {
      await this.evaluateRollover();
      await this.deliverPendingAnnouncements();
      await this.refreshPresence();
      const active = await this.getActiveSeason();
      if (active) this.scheduleDeadline(active);
    } catch (error) {
      console.error("Season maintenance failed:", error);
    }
  }

  static async afterGameSaved(): Promise<void> {
    const outcome = await this.evaluateRollover(false);
    if (!outcome.closed) {
      const { season, finishedGames } = await this.getStatus();
      if (season.firstRolloverAt) {
        await DiscordUtil.sendMessage(
          "gameFeed",
          `📅 Season ${season.number}: first rollover scheduled for <t:${Math.floor(season.firstRolloverAt.getTime() / 1000)}:F>.`
        );
        await this.refreshPresence();
        return;
      }
      const gameText = season.gameLimit
        ? `${Math.max(0, season.gameLimit - finishedGames)} game(s) remaining`
        : "no game limit";
      const timeText = season.rolloverDeadline
        ? `${Math.max(0, Math.ceil((season.rolloverDeadline.getTime() - Date.now()) / 86_400_000))} day(s) remaining`
        : "no time limit";
      await DiscordUtil.sendMessage(
        "gameFeed",
        `📅 Season ${season.number}: ${gameText}; ${timeText}.`
      );
    } else {
      await DiscordUtil.sendMessage(
        "gameFeed",
        "📅 Season rollover completed. The next season is now active."
      );
    }
    await this.refreshPresence();
  }

  static async evaluateRollover(
    gameActive = CurrentGameManager.getCurrentGame().announced
  ): Promise<{ closed: boolean; pending: boolean }> {
    const season = await this.getActiveSeason();
    if (!season) return { closed: false, pending: false };
    const scheduled = Boolean(season.firstRolloverAt);
    if (
      season.firstRolloverAt &&
      season.firstRolloverAt.getTime() > Date.now()
    ) {
      return { closed: false, pending: false };
    }
    const finishedGames = await prismaClient.game.count({
      where: { seasonId: season.id, finished: true },
    });
    const gameReached = Boolean(
      season.gameLimit && finishedGames >= season.gameLimit
    );
    const monthReached = Boolean(
      season.rolloverDeadline && season.rolloverDeadline.getTime() <= Date.now()
    );
    if (
      !scheduled &&
      !gameReached &&
      !monthReached &&
      !season.rolloverPending
    ) {
      return { closed: false, pending: false };
    }
    const reason = scheduled
      ? SeasonClosureReason.SCHEDULED
      : gameReached
        ? SeasonClosureReason.GAME_LIMIT
        : monthReached
          ? SeasonClosureReason.MONTH_LIMIT
          : (season.closureReason ?? SeasonClosureReason.MONTH_LIMIT);
    if (gameActive) {
      await prismaClient.season.update({
        where: { id: season.id },
        data: { rolloverPending: true, closureReason: reason },
      });
      await this.refreshPresence();
      return { closed: false, pending: true };
    }
    await this.closeActiveSeason(reason);
    return { closed: true, pending: false };
  }

  static async closeActiveSeason(
    reason: SeasonClosureReason,
    nextType?: SeasonType
  ): Promise<Season> {
    if (
      reason === SeasonClosureReason.MANUAL &&
      CurrentGameManager.getCurrentGame().announced
    ) {
      throw new Error(
        "The season cannot be ended while a game is announced or underway. Finish or cancel that game first."
      );
    }
    const active = await this.requireActiveSeason();
    const token = randomUUID();
    const locked = await prismaClient.season.updateMany({
      where: {
        id: active.id,
        isActive: true,
        OR: [
          { lifecycleState: SeasonLifecycleState.ACTIVE },
          { lifecycleState: null },
          // Legacy MongoDB seasons may predate this field entirely.
          { lifecycleState: { isSet: false } },
        ],
      },
      data: {
        lifecycleState: SeasonLifecycleState.CLOSING,
        lifecycleToken: token,
        closureReason: reason,
        closureRequestedAt: new Date(),
        nextTypeOverride: nextType ?? active.nextTypeOverride,
      },
    });
    if (locked.count === 0) {
      const current = await prismaClient.season.findUnique({
        where: { id: active.id },
      });
      if (current?.lifecycleState === SeasonLifecycleState.CLOSING) {
        return this.finishClosure(current.id);
      }
      logger.warn(
        `Season ${active.number} closure could not be claimed: isActive=${current?.isActive}, lifecycleState=${current?.lifecycleState ?? "unset"}.`
      );
      throw new Error(
        "The season changed before closure could start. Check /season status and try again."
      );
    }
    return this.finishClosure(active.id);
  }

  private static async recoverClosures(): Promise<void> {
    const closing = await prismaClient.season.findMany({
      where: {
        OR: [
          { lifecycleState: SeasonLifecycleState.CLOSING },
          {
            lifecycleState: SeasonLifecycleState.CLOSED,
            OR: [{ recapProcessedAt: null }, { titlesProcessedAt: null }],
          },
        ],
      },
      orderBy: { number: "asc" },
    });
    for (const season of closing) await this.finishClosure(season.id);
  }

  private static async finishClosure(closingSeasonId: string): Promise<Season> {
    let closing = await prismaClient.season.findUnique({
      where: { id: closingSeasonId },
    });
    if (!closing) throw new Error("Closing season no longer exists.");
    let successor = closing.successorSeasonId
      ? await prismaClient.season.findUnique({
          where: { id: closing.successorSeasonId },
        })
      : null;
    successor ??= await prismaClient.season.findFirst({
      where: { isActive: true, number: { gt: closing.number } },
      orderBy: { number: "asc" },
    });
    if (!successor) {
      const latest = await prismaClient.season.findFirst({
        orderBy: { number: "desc" },
      });
      const number = Math.max(closing.number, latest?.number ?? 0) + 1;
      const successorType =
        closing.nextTypeOverride ??
        ((closing.type ?? SeasonType.RANKED) === SeasonType.RANKED
          ? SeasonType.RELAXED
          : SeasonType.RANKED);
      const rankedGameLimit = closing.rankedGameLimit ?? closing.gameLimit;
      const rankedMonthLimit = closing.rankedMonthLimit ?? closing.monthLimit;
      const limits = this.limitsForType(
        successorType,
        rankedGameLimit,
        rankedMonthLimit
      );
      successor = await prismaClient.season.create({
        data: {
          number,
          name: `Season ${number}`,
          startDate: new Date(),
          isActive: true,
          type: successorType,
          rankedGameLimit,
          rankedMonthLimit,
          ...limits,
          rolloverDeadline: this.calculateDeadline(
            new Date(),
            limits.monthLimit
          ),
          lifecycleState: SeasonLifecycleState.ACTIVE,
        },
      });
      closing = await prismaClient.season.update({
        where: { id: closing.id },
        data: {
          isActive: false,
          lifecycleState: SeasonLifecycleState.CLOSED,
          lifecycleToken: null,
          rolloverPending: false,
          closedAt: new Date(),
          endDate: new Date(),
          successorSeasonId: successor.id,
        },
      });
    } else if (
      !closing.successorSeasonId ||
      closing.lifecycleState !== SeasonLifecycleState.CLOSED
    ) {
      closing = await prismaClient.season.update({
        where: { id: closing.id },
        data: {
          isActive: false,
          lifecycleState: SeasonLifecycleState.CLOSED,
          lifecycleToken: null,
          rolloverPending: false,
          closedAt: closing.closedAt ?? new Date(),
          endDate: closing.endDate ?? new Date(),
          successorSeasonId: successor.id,
        },
      });
    }

    if (!closing.recapProcessedAt) {
      try {
        const blocks =
          closing.type === SeasonType.RELAXED
            ? await this.relaxedRecap(closing)
            : (await generateSeasonRecap({ seasonNumber: closing.number }))
                .blocks;
        await this.queueBlocks(
          closing.id,
          SeasonAnnouncementKind.RECAP,
          blocks
        );
        closing = await prismaClient.season.update({
          where: { id: closing.id },
          data: { recapProcessedAt: new Date() },
        });
      } catch (error) {
        console.error(
          `Failed to prepare Season ${closing.number} recap:`,
          error
        );
      }
    }
    if (!closing.titlesProcessedAt) {
      try {
        const titles = await TitleService.reconcile(closing.id);
        await this.queueBlocks(
          closing.id,
          SeasonAnnouncementKind.TITLES,
          titles.blocks
        );
        closing = await prismaClient.season.update({
          where: { id: closing.id },
          data: { titlesProcessedAt: new Date() },
        });
      } catch (error) {
        console.error(
          `Failed to award Season ${closing.number} titles:`,
          error
        );
      }
    }
    await this.queueBlocks(closing.id, SeasonAnnouncementKind.NEW_SEASON, [
      this.newSeasonMessage(successor),
    ]);
    await this.deliverPendingAnnouncements();
    this.scheduleDeadline(successor);
    await this.refreshPresence();
    return successor;
  }

  private static async relaxedRecap(season: Season): Promise<string[]> {
    const [games, stats, mvps] = await Promise.all([
      prismaClient.game.count({
        where: { seasonId: season.id, finished: true },
      }),
      prismaClient.playerStats.findMany({
        where: { seasonId: season.id },
        include: { player: { select: { latestIGN: true } } },
        orderBy: [{ wins: "desc" }, { biggestWinStreak: "desc" }],
      }),
      prismaClient.gameParticipation.findMany({
        where: { seasonId: season.id, mvp: true },
        select: { playerId: true },
      }),
    ]);
    const mvpCount = new Map<string, number>();
    for (const row of mvps)
      mvpCount.set(row.playerId, (mvpCount.get(row.playerId) ?? 0) + 1);
    const active = [...stats]
      .sort((a, b) => b.wins + b.losses - (a.wins + a.losses))
      .slice(0, 10)
      .map(
        (row) =>
          `• **${row.player?.latestIGN ?? "Unknown"}** — ${row.wins + row.losses} games, ${row.wins} wins, ${mvpCount.get(row.playerId) ?? 0} MVPs`
      );
    return [
      [
        `🎉 **Season ${season.number} Relaxed Recap**`,
        `${games} games were played by ${stats.length} players. This season was unranked, so no Elo or placement winner was recorded.`,
        "",
        "**Activity highlights**",
        ...(active.length ? active : ["No finished games were recorded."]),
      ].join("\n"),
    ];
  }

  private static newSeasonMessage(season: Season): string {
    const limits = [
      season.gameLimit ? `${season.gameLimit} games` : null,
      season.monthLimit ? `${season.monthLimit} calendar month(s)` : null,
    ].filter(Boolean);
    return `🌱 **Season ${season.number} is now live — ${season.type === SeasonType.RELAXED ? "Relaxed" : "Ranked"}!**\n${limits.length ? `The season ends after ${limits.join(" or ")}, whichever comes first.` : "Automatic rollover is currently disabled."}`;
  }

  private static async queueBlocks(
    seasonId: string,
    kind: SeasonAnnouncementKind,
    blocks: string[]
  ): Promise<void> {
    for (const [blockIndex, raw] of blocks.entries()) {
      const marker = `〔season:${seasonId}:${kind}:${blockIndex}〕`;
      const content = `${marker}\n${raw}`;
      await prismaClient.seasonAnnouncement.upsert({
        where: { seasonId_kind_blockIndex: { seasonId, kind, blockIndex } },
        update: {},
        create: { seasonId, kind, blockIndex, marker, content },
      });
    }
  }

  static async deliverPendingAnnouncements(): Promise<void> {
    const pending = await prismaClient.seasonAnnouncement.findMany({
      where: { state: AnnouncementDeliveryState.PENDING },
      orderBy: { createdAt: "asc" },
    });
    if (!pending.length) return;
    pending.sort((a, b) => {
      if (a.seasonId !== b.seasonId)
        return a.createdAt.getTime() - b.createdAt.getTime();
      const kind =
        ANNOUNCEMENT_ORDER.indexOf(a.kind) - ANNOUNCEMENT_ORDER.indexOf(b.kind);
      return kind || a.blockIndex - b.blockIndex;
    });
    const seasons = await prismaClient.season.findMany({
      where: {
        id: { in: [...new Set(pending.map((block) => block.seasonId))] },
      },
    });
    const seasonById = new Map(seasons.map((season) => [season.id, season]));
    for (const block of pending) {
      const season = seasonById.get(block.seasonId);
      if (season?.lifecycleState === SeasonLifecycleState.CLOSED) {
        if (
          block.kind !== SeasonAnnouncementKind.RECAP &&
          !season.recapProcessedAt
        ) {
          continue;
        }
        if (
          block.kind === SeasonAnnouncementKind.NEW_SEASON &&
          !season.titlesProcessedAt
        ) {
          continue;
        }
      }
      try {
        const existing = await this.findDeliveredMarker(block.marker);
        const message =
          existing ?? (await Channels.announcements.send(block.content));
        await prismaClient.seasonAnnouncement.update({
          where: { id: block.id },
          data: {
            state: AnnouncementDeliveryState.DELIVERED,
            discordMessageId: message.id,
            deliveredAt: new Date(),
            lastAttemptAt: new Date(),
            attempts: { increment: 1 },
            lastError: null,
          },
        });
      } catch (error) {
        await prismaClient.seasonAnnouncement.update({
          where: { id: block.id },
          data: {
            attempts: { increment: 1 },
            lastAttemptAt: new Date(),
            lastError:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "Unknown delivery error",
          },
        });
        break;
      }
    }
  }

  private static async findDeliveredMarker(
    marker: string
  ): Promise<Message | null> {
    const channel = Channels.announcements as TextBasedChannel;
    if (!("messages" in channel) || !channel.messages) return null;
    const messages = await channel.messages
      .fetch({ limit: 100 })
      .catch(() => null);
    return (
      messages?.find((message) => message.content.includes(marker)) ?? null
    );
  }

  static async refreshPresence(): Promise<void> {
    if (!this.client?.user) return;
    const season = await this.getActiveSeason();
    if (!season) {
      this.client.user.setActivity("No active season", {
        type: ActivityType.Competing,
      });
      return;
    }
    const games = await prismaClient.game.count({
      where: { seasonId: season.id, finished: true },
    });
    const automated = Boolean(season.gameLimit || season.monthLimit);
    let progress = "";
    if (season.rolloverPending) progress = " • rollover pending";
    else if (season.firstRolloverAt) {
      progress = ` • rollover ${season.firstRolloverAt.toISOString().slice(0, 10)} UTC`;
    } else if (automated) {
      const bits = [
        season.gameLimit ? `${games}/${season.gameLimit} games` : null,
        season.rolloverDeadline
          ? `${Math.max(0, Math.ceil((season.rolloverDeadline.getTime() - Date.now()) / 86_400_000))}d left`
          : null,
      ].filter(Boolean);
      progress = ` • ${bits.join(" / ")}`;
    }
    this.client.user.setActivity(
      `S${season.number} ${season.type === SeasonType.RELAXED ? "Relaxed" : "Ranked"}${progress}`,
      { type: ActivityType.Competing }
    );
  }

  private static scheduleDeadline(season: Season): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    // A pending rollover waits for game completion, rather than spinning a timer.
    if (season.rolloverPending) return;
    const deadline = season.firstRolloverAt ?? season.rolloverDeadline;
    if (!deadline) return;
    const delay = Math.min(
      2_147_000_000,
      Math.max(0, deadline.getTime() - Date.now())
    );
    this.deadlineTimer = setTimeout(
      () => void this.periodicMaintenance(),
      delay
    );
  }
}
