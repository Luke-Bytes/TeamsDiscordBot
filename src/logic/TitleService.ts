import { SeasonType } from "@prisma/client";
import { prismaClient } from "../database/prismaClient";
import { TitleStore } from "../util/TitleStore";
import { formatTitleLabel } from "../util/ProfileUtil";
import { escapeText } from "../util/Utils";

export type NewlyUnlockedTitle = {
  playerId: string;
  ign: string;
  discordSnowflake: string | null;
  titleIds: string[];
};

export type TitleReconciliationResult = {
  newlyUnlocked: NewlyUnlockedTitle[];
  blocks: string[];
};

/** Idempotent title calculation shared by season closure and /scripts repair. */
export class TitleService {
  static async reconcile(
    closingSeasonId?: string
  ): Promise<TitleReconciliationResult> {
    const available = new Set(TitleStore.loadTitles().map((title) => title.id));
    const awards = new Map<string, Set<string>>();
    const award = (playerId: string, titleId: string) => {
      if (!available.has(titleId)) return;
      const playerAwards = awards.get(playerId) ?? new Set<string>();
      playerAwards.add(titleId);
      awards.set(playerId, playerAwards);
    };

    const [stats, mvps, captains, games, players] = await Promise.all([
      prismaClient.playerStats.findMany(),
      prismaClient.gameParticipation.findMany({
        where: { mvp: true },
        select: { playerId: true },
      }),
      prismaClient.gameParticipation.findMany({
        where: { captain: true },
        select: {
          playerId: true,
          team: true,
          game: { select: { winner: true } },
        },
      }),
      prismaClient.game.findMany({ select: { organiser: true, host: true } }),
      prismaClient.player.findMany({
        select: { id: true, latestIGN: true, discordSnowflake: true },
      }),
    ]);

    const lifetime = new Map<string, { wins: number; losses: number }>();
    for (const row of stats) {
      const value = lifetime.get(row.playerId) ?? { wins: 0, losses: 0 };
      value.wins += row.wins;
      value.losses += row.losses;
      lifetime.set(row.playerId, value);
    }
    for (const [playerId, value] of lifetime) {
      if (value.wins >= 25) award(playerId, "UNYIELDING");
      if (value.wins >= 50) award(playerId, "CARRY");
      if (value.wins + value.losses >= 100) award(playerId, "VETERAN");
    }

    const countByPlayer = (rows: Array<{ playerId: string }>) => {
      const counts = new Map<string, number>();
      for (const row of rows)
        counts.set(row.playerId, (counts.get(row.playerId) ?? 0) + 1);
      return counts;
    };
    for (const [playerId, count] of countByPlayer(mvps)) {
      if (count >= 10) award(playerId, "PARAGON");
    }
    const captainWins = captains.filter((row) => row.team === row.game.winner);
    for (const [playerId, count] of countByPlayer(captainWins)) {
      if (count >= 10) award(playerId, "COMMODORE");
    }

    const playerIdByIgn = new Map(
      players
        .filter((player) => player.latestIGN)
        .map((player) => [player.latestIGN!.toLowerCase(), player.id])
    );
    const hosted = new Map<string, number>();
    for (const game of games) {
      for (const name of [game.organiser, game.host]) {
        const playerId = name
          ? playerIdByIgn.get(name.trim().toLowerCase())
          : undefined;
        if (playerId) hosted.set(playerId, (hosted.get(playerId) ?? 0) + 1);
      }
    }
    for (const [playerId, count] of hosted) {
      if (count >= 25) award(playerId, "OVERSEER");
    }

    const placementSeasons = closingSeasonId
      ? [
          await prismaClient.season.findUnique({
            where: { id: closingSeasonId },
          }),
        ]
      : await prismaClient.season.findMany({
          where: {
            isActive: false,
            OR: [{ type: SeasonType.RANKED }, { type: null }],
          },
        });
    for (const season of placementSeasons) {
      if (season && season.type !== SeasonType.RELAXED) {
        const ranked = stats
          .filter((row) => row.seasonId === season.id)
          .sort((a, b) => b.elo - a.elo);
        let previousElo: number | undefined;
        let competitionRank = 0;
        ranked.forEach((row, index) => {
          if (row.elo !== previousElo) competitionRank = index + 1;
          previousElo = row.elo;
          if (competitionRank === 1) award(row.playerId, "CHAMPION");
          if (competitionRank <= 2) award(row.playerId, "ACE");
          if (competitionRank <= 3) award(row.playerId, "ELITE");
        });
      }
    }

    const playerById = new Map(players.map((player) => [player.id, player]));
    const newlyUnlocked: NewlyUnlockedTitle[] = [];
    for (const [playerId, playerAwards] of awards) {
      const existing = await prismaClient.profile.findUnique({
        where: { playerId },
      });
      const old = existing?.unlockedTitles ?? [];
      const newIds = [...playerAwards].filter((id) => !old.includes(id));
      await prismaClient.profile.upsert({
        where: { playerId },
        update: { unlockedTitles: [...new Set([...old, ...playerAwards])] },
        create: { playerId, unlockedTitles: [...playerAwards] },
      });
      if (newIds.length) {
        const player = playerById.get(playerId);
        newlyUnlocked.push({
          playerId,
          ign: player?.latestIGN ?? "Unknown",
          discordSnowflake: player?.discordSnowflake ?? null,
          titleIds: newIds,
        });
      }
    }

    return { newlyUnlocked, blocks: this.buildAnnouncement(newlyUnlocked) };
  }

  private static buildAnnouncement(rows: NewlyUnlockedTitle[]): string[] {
    if (!rows.length) return [];
    const definitions = TitleStore.loadTitles();
    const lines = rows.map((row) => {
      const who = row.discordSnowflake
        ? `<@${row.discordSnowflake}>`
        : `**${escapeText(row.ign)}**`;
      const titles = row.titleIds
        .map((id) => formatTitleLabel(id, definitions) ?? id)
        .map((label) => `**${escapeText(label)}**`)
        .join(", ");
      return `✦ ${who} unlocked ${titles}`;
    });
    return splitBlocks([
      "🏷️ **New Titles Unlocked**",
      "Use `/profilecreate` to choose and equip an unlocked title.",
      ...lines,
    ]);
  }
}

function splitBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let block = "";
  for (const line of lines) {
    const next = block ? `${block}\n${line}` : line;
    if (next.length <= 1800) block = next;
    else {
      if (block) blocks.push(block);
      block = line;
    }
  }
  if (block) blocks.push(block);
  return blocks;
}
