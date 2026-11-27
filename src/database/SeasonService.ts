import { ActivityType, Client, Message, TextBasedChannel } from "discord.js";
import {
  AnnouncementDeliveryState,
  Prisma,
  Season,
  SeasonAnnouncementKind,
  SeasonAnnouncement,
  SeasonClosureReason,
  SeasonLifecycleState,
  SeasonType,
} from "@prisma/client";
import { createHash, randomUUID } from "crypto";
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
  private static lifecycleQueue: Promise<unknown> = Promise.resolve();
  private static queuedMaintenance?: Promise<void>;
  private static deliveryTail: Promise<unknown> = Promise.resolve();
  private static queuedDelivery?: Promise<void>;
  private static closureInProgress = false;

  /** Synchronous guard for game installation, including Discord recovery. */
  static assertGameAdmission(): void {
    if (this.closureInProgress)
      throw new Error("Season rollover is in progress. Retry after it completes.");
  }

  /** Keep season selection and the synchronous game transition in one turn of the lifecycle queue. */
  static withGameAdmission<T>(admit: (season: Season) => T): Promise<T> {
    return this.serializeLifecycle(async () => {
      const season = await this.requireActiveSeason();
      if (season.lifecycleState === SeasonLifecycleState.CLOSING)
        throw new Error("Season rollover is incomplete. Retry after it completes.");
      return admit(season);
    });
  }

  private static async withClosure<T>(work: () => Promise<T>): Promise<T> {
    this.closureInProgress = true;
    try {
      return await work();
    } finally {
      this.closureInProgress = false;
    }
  }

  /** Queue, rather than drop, overlapping lifecycle requests. */
  private static serializeLifecycle<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(work);
    this.lifecycleQueue = result.catch(() => undefined);
    return result;
  }

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
    const target = await this.requireActiveSeason();
    const { updated, closed } = await this.serializeLifecycle(async () => {
      const season = await this.requireActiveSeason();
      if (season.id !== target.id) {
        throw new Error(
          "The season changed before configuration could be saved. Check /season status and try again."
        );
      }
      return this.configureSeason(season, configuration);
    });
    if (closed) await this.deliverPendingAnnouncements();
    return updated;
  }

  private static async configureSeason(
    season: Season,
    configuration: SeasonConfiguration
  ): Promise<{ updated: Season; closed: boolean }> {
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
      if (CurrentGameManager.getCurrentGame().announced)
        throw new Error("The current season type cannot change while a game is announced.");
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
    const { closed } = await this.evaluateRolloverInternal();
    await this.refreshPresence();
    const current = await this.getActiveSeason();
    if (current) this.scheduleDeadline(current);
    return { updated, closed };
  }

  static async bootstrap(
    type: SeasonType,
    requestedNumber?: number
  ): Promise<Season> {
    const season = await this.serializeLifecycle(() =>
      this.bootstrapSeason(type, requestedNumber)
    );
    await this.deliverPendingAnnouncements();
    return season;
  }

  private static async bootstrapSeason(
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
    await this.refreshPresence();
    return season;
  }

  static async initialize(client: Client): Promise<void> {
    this.client = client;
    await this.serializeLifecycle(() => this.maintainSeasons());
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = setInterval(
      () => {
        void this.periodicMaintenance();
      },
      15 * 60 * 1000
    );
    await this.deliverPendingAnnouncements();
  }

  private static periodicMaintenance(): Promise<void> {
    // At most one pass may wait in the queue, in addition to the running pass.
    // Keep one pending tick so a deadline reached mid-pass is not lost.
    if (this.queuedMaintenance) return this.queuedMaintenance;
    const work = this.serializeLifecycle(async () => {
      this.queuedMaintenance = undefined;
      await this.maintainSeasons();
    })
      // Discord delivery must not hold the season admission/lifecycle queue.
      .then(() => this.deliverPendingAnnouncements())
      .catch((error) => {
        console.error("Season maintenance failed:", error);
      });
    this.queuedMaintenance = work;
    return work;
  }

  private static async maintainSeasons(): Promise<void> {
    await this.recoverClosures();
    await this.evaluateRolloverInternal();
    await this.refreshPresence();
    const active = await this.getActiveSeason();
    if (active) this.scheduleDeadline(active);
  }

  static async afterGameSaved(): Promise<void> {
    const outcome = await this.evaluateRollover(false);
    if (!outcome.closed) {
      const season = await this.requireActiveSeason();
      if (season.firstRolloverAt) {
        await DiscordUtil.sendMessage(
          "gameFeed",
          `📅 Season ${season.number}: first rollover scheduled for <t:${Math.floor(season.firstRolloverAt.getTime() / 1000)}:F>.`
        );
        await this.refreshPresence();
        return;
      }
      const finishedGames = season.gameLimit
        ? await prismaClient.game.count({
            where: { seasonId: season.id, finished: true },
          })
        : 0;
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
    gameActive?: boolean
  ): Promise<{ closed: boolean; pending: boolean }> {
    const result = await this.serializeLifecycle(() =>
      this.evaluateRolloverInternal(gameActive)
    );
    if (result.closed) await this.deliverPendingAnnouncements();
    return result;
  }

  private static async evaluateRolloverInternal(
    gameActive?: boolean
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
    // A scheduled rollover takes precedence over game limits; without a limit
    // the count cannot change the closure decision or its reason.
    const gameReached = Boolean(
      !scheduled &&
        season.gameLimit &&
        (await prismaClient.game.count({
          where: { seasonId: season.id, finished: true },
        })) >= season.gameLimit
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
    // Re-read after the count; never apply a decision to a different season
    // or to configuration changed while the count was in flight.
    const current = await this.getActiveSeason();
    if (!current || current.id !== season.id)
      return { closed: false, pending: false };
    if (
      current.gameLimit !== season.gameLimit ||
      current.firstRolloverAt?.getTime() !==
        season.firstRolloverAt?.getTime() ||
      current.rolloverDeadline?.getTime() !==
        season.rolloverDeadline?.getTime() ||
      current.rolloverPending !== season.rolloverPending ||
      current.closureReason !== season.closureReason
    )
      return { closed: false, pending: false };
    if (gameActive ?? CurrentGameManager.getCurrentGame().announced) {
      await prismaClient.season.update({
        where: { id: season.id },
        data: { rolloverPending: true, closureReason: reason },
      });
      await this.refreshPresence();
      return { closed: false, pending: true };
    }
    await this.closeSeason(current, reason);
    return { closed: true, pending: false };
  }

  static async closeActiveSeason(
    reason: SeasonClosureReason,
    nextType?: SeasonType,
    expectedSeasonId?: string
  ): Promise<Season> {
    // Capture the target before waiting for another closure or maintenance run.
    const targetId = expectedSeasonId ?? (await this.requireActiveSeason()).id;
    const successor = await this.serializeLifecycle(async () => {
      const active = await this.requireActiveSeason();
      if (active.id !== targetId) {
        throw new Error(
          "The season changed before closure could start. Check /season status and try again."
        );
      }
      return this.closeSeason(active, reason, nextType);
    });
    await this.deliverPendingAnnouncements();
    return successor;
  }

  private static async closeSeason(
    active: Season,
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
    return this.withClosure(() => this.claimAndFinishClosure(active, reason, nextType));
  }

  private static async claimAndFinishClosure(
    active: Season,
    reason: SeasonClosureReason,
    nextType?: SeasonType
  ): Promise<Season> {
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
            OR: [
              { recapProcessedAt: null },
              { recapProcessedAt: { isSet: false } },
              { titlesProcessedAt: null },
              { titlesProcessedAt: { isSet: false } },
            ],
          },
        ],
      },
      orderBy: { number: "asc" },
    });
    for (const season of closing) {
      // A recovered active match must finish before an incomplete rollover
      // changes its season. Closed-season outbox/checkpoint repair is safe.
      if (season.lifecycleState === SeasonLifecycleState.CLOSING &&
          CurrentGameManager.getCurrentGame().announced) continue;
      await this.withClosure(() => this.finishClosure(season.id));
    }
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

    // Persist this before the processing checkpoints so a failed queue write
    // cannot leave a fully processed closure with no successor announcement.
    await this.queueBlocks(closing.id, SeasonAnnouncementKind.NEW_SEASON, [
      this.newSeasonMessage(successor),
    ]);

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
        const closingId = closing.id;
        await TitleService.reconcile(closingId, async (tx, titles) => {
          await this.queueBlocks(
            closingId,
            SeasonAnnouncementKind.TITLES,
            titles.blocks,
            tx
          );
          await tx.season.update({
            where: { id: closingId },
            data: { titlesProcessedAt: new Date() },
          });
        });
      } catch (error) {
        console.error(
          `Failed to award Season ${closing.number} titles:`,
          error
        );
      }
    }
    const active = await this.getActiveSeason();
    if (active) this.scheduleDeadline(active);
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
        `## 🎉 Season ${season.number} Relaxed Recap`,
        "",
        `${games} games were played by ${stats.length} players. This season was unranked, so no Elo or placement winner was recorded.`,
        "",
        "### Activity highlights",
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
    blocks: string[],
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    for (const [blockIndex, raw] of blocks.entries()) {
      const marker = `〔season:${seasonId}:${kind}:${blockIndex}〕`;
      const args = {
        where: { seasonId_kind_blockIndex: { seasonId, kind, blockIndex } },
        update: {},
        create: { seasonId, kind, blockIndex, marker, content: raw },
      };
      if (tx) await tx.seasonAnnouncement.upsert(args);
      else await prismaClient.seasonAnnouncement.upsert(args);
    }
  }

  static deliverPendingAnnouncements(): Promise<void> {
    // Keep delivery ordered and non-overlapping independently of lifecycle
    // changes. Retain one pending pass so newly queued blocks are not missed.
    if (this.queuedDelivery) return this.queuedDelivery;
    const work = this.deliveryTail.then(async () => {
      this.queuedDelivery = undefined;
      await this.deliverPendingAnnouncementsPass();
    });
    this.queuedDelivery = work;
    this.deliveryTail = work.catch(() => undefined);
    return work;
  }

  private static async deliverPendingAnnouncementsPass(): Promise<void> {
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
        // Also strip the prefix from announcements queued by older versions.
        const prefix = `${block.marker}\n`;
        const content = block.content.startsWith(prefix)
          ? block.content.slice(prefix.length)
          : block.content;
        const nonce = createHash("sha256")
          .update(block.marker)
          .digest("hex")
          .slice(0, 24);
        const existing = await this.findDeliveredAnnouncement(block, content);
        const message =
          existing ??
          (await Channels.announcements.send({
            content,
            nonce,
            enforceNonce: true,
            allowedMentions: { parse: [] },
          }));
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

  private static async findDeliveredAnnouncement(
    block: SeasonAnnouncement,
    content: string
  ): Promise<Message | null> {
    const channel = Channels.announcements as TextBasedChannel;
    if (!("messages" in channel) || !channel.messages) return null;
    if (block.discordMessageId) {
      const saved = await channel.messages
        .fetch(block.discordMessageId)
        .catch(() => null);
      if (saved) return saved;
    }
    const messages = await channel.messages
      .fetch({ limit: 100 })
      .catch(() => null);
    for (const message of messages?.values() ?? []) {
      if (message.author.id !== channel.client.user?.id) continue;
      if (message.content.includes(block.marker)) return message;
      if (
        message.content !== content ||
        message.createdTimestamp < block.createdAt.getTime()
      )
        continue;
      // Identical text can belong to a different season or announcement block.
      const claimed = await prismaClient.seasonAnnouncement.findFirst({
        where: { discordMessageId: message.id, id: { not: block.id } },
      });
      if (!claimed) return message;
    }
    return null;
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
    const automated = Boolean(season.gameLimit || season.monthLimit);
    let progress = "";
    if (season.rolloverPending) progress = " • rollover pending";
    else if (season.firstRolloverAt) {
      progress = ` • rollover ${season.firstRolloverAt.toISOString().slice(0, 10)} UTC`;
    } else if (automated) {
      const games = season.gameLimit
        ? await prismaClient.game.count({
            where: { seasonId: season.id, finished: true },
          })
        : 0;
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
