import { prismaClient } from "../database/prismaClient";
import { TitleStore } from "./TitleStore";
import { formatTitleLabel, normalizeTitleIds } from "./ProfileUtil";
import { escapeText } from "./Utils";
import { PrismaSafeExtractor } from "./PrismaSafeExtractor";

export class PrismaUtils {
  private static readonly punishmentOperations = new Map<string, Promise<void>>();

  /** Order local ban additions and the final roster admission for one player. */
  static async withPunishmentAdmission<T>(playerId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.punishmentOperations.get(playerId);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    this.punishmentOperations.set(playerId, pending);
    try {
      await previous;
      return await work();
    } finally {
      release();
      if (this.punishmentOperations.get(playerId) === pending)
        this.punishmentOperations.delete(playerId);
    }
  }

  static async findPlayer(identifier: string) {
    identifier = identifier.replace(/<@([^>]+)>/g, "$1");
    return await prismaClient.player.findFirst({
      where: {
        OR: [
          { discordSnowflake: identifier },
          {
            latestIGN: {
              equals: identifier,
              mode: "insensitive",
            },
          },
        ],
      },
    });
  }

  static async getPlayerData(
    identifier: string,
    fields: (keyof typeof prismaClient.player)[]
  ) {
    const player = await PrismaUtils.findPlayer(identifier);
    if (!player) return null;

    const selectFields = Object.fromEntries(
      fields.map((field) => [field, true])
    );

    return await prismaClient.player.findUnique({
      where: { id: player.id },
      select: selectFields,
    });
  }

  static async registrationPunishmentError(playerId: string): Promise<string | undefined> {
    const punishment = await prismaClient.playerPunishment.findFirst({
      where: {
        playerId,
        AND: [
          { punishmentExpiry: { not: null } },
          { punishmentExpiry: { gt: new Date() } },
        ],
      },
    });
    if (!punishment) return;
    const expiryDate = punishment.punishmentExpiry
      ? new Intl.DateTimeFormat("en-US", {
          weekday: "long", day: "numeric", month: "long", year: "numeric",
        }).format(punishment.punishmentExpiry)
      : "unknown";
    return `You cannot register because you are currently banned from friendly wars. Your punishment will expire on **${expiryDate}**.`;
  }

  static async updatePunishmentsForExpiry() {
    const now = new Date();
    // Match expiry at write time so a concurrently extended punishment is safe.
    // MongoDB distinguishes missing fields from explicit nulls.
    for (let attempt = 0; ; attempt++) {
      try {
        const { count } = await prismaClient.playerPunishment.updateMany({
          where: {
            punishmentExpiry: { isSet: true, not: null, lte: now },
          },
          data: { punishmentExpiry: null },
        });
        return count;
      } catch (error) {
        // A rolled-back write conflict can be retried against the current state.
        if (attempt >= 2 || (error as { code?: string })?.code !== "P2034") {
          throw error;
        }
      }
    }
  }

  static async getPlayerTitle(identifier: string) {
    const player = await PrismaUtils.findPlayer(identifier);
    if (!player) return null;
    const profile = await (
      prismaClient as unknown as {
        profile?: {
          findUnique: (args: {
            where: { playerId: string };
          }) => Promise<{ title?: string | null } | null>;
        };
      }
    ).profile?.findUnique({
      where: { playerId: player.id },
    });
    return profile?.title ?? null;
  }

  static async getDisplayNameWithTitle(
    playerId: string,
    baseName: string
  ): Promise<string> {
    if (!playerId) return baseName;
    const profile = await (
      prismaClient as unknown as {
        profile?: {
          findUnique: (args: { where: { playerId: string } }) => Promise<{
            title?: string | null;
            unlockedTitles?: string[];
          } | null>;
        };
      }
    ).profile?.findUnique({
      where: { playerId },
    });
    const unlocked = normalizeTitleIds(profile?.unlockedTitles ?? []);
    if (!profile?.title || !unlocked.includes(profile.title)) {
      return baseName;
    }
    const titles = TitleStore.loadTitles().filter((t) =>
      unlocked.includes(t.id)
    );
    const titleLabel = formatTitleLabel(profile.title, titles);
    if (!titleLabel) return baseName;
    return `${baseName} the ${escapeText(titleLabel)}`;
  }

  static async safeFindGamesForHostOrganiserCounts(): Promise<
    Array<{ organiser: string | null; host: string | null }>
  > {
    return PrismaSafeExtractor.safeFindGamesForHostOrganiserCounts();
  }

  static async safeFindCaptainParticipations(): Promise<
    Array<{ playerId: string; team: string | null; winner: string | null }>
  > {
    return PrismaSafeExtractor.safeFindCaptainParticipations();
  }
}
