import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { TitleStore } from "../util/TitleStore";
import { prismaClient } from "../database/prismaClient";

type ProfileModel = {
  findUnique: (args: { where: { playerId: string } }) => Promise<unknown>;
  upsert: (args: {
    where: { playerId: string };
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  }) => Promise<unknown>;
};

function getProfileModel(): ProfileModel | undefined {
  return (prismaClient as unknown as { profile?: ProfileModel }).profile;
}

type AwardCounts = Record<string, number>;

export default class ScriptsCommand implements Command {
  name = "scripts";
  description = "Run organiser scripts";
  buttonIds: string[] = [];
  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addSubcommand((sub) =>
      sub
        .setName("titles-update")
        .setDescription("Award titles based on lifetime stats")
    );

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const isAuthorized = await PermissionsUtil.isUserAuthorised(interaction);
    if (!isAuthorized) return;

    const sub = interaction.options.getSubcommand();
    if (sub === "titles-update") {
      await interaction.reply({
        content: "Running titles update...",
      });
      const summary = await this.runTitlesUpdate();
      await interaction.editReply({
        content: summary,
      });
      return;
    }

    await interaction.reply({
      content: "Unknown script.",
      flags: 64,
    });
  }

  private async runTitlesUpdate(): Promise<string> {
    const available = new Set(TitleStore.loadTitles().map((t) => t.id));
    const awardsByPlayer = new Map<string, Set<string>>();
    const awardCounts: AwardCounts = {};

    const ensureAward = (playerId: string, titleId: string) => {
      if (!available.has(titleId)) return;
      if (!awardsByPlayer.has(playerId)) {
        awardsByPlayer.set(playerId, new Set());
      }
      const set = awardsByPlayer.get(playerId)!;
      if (!set.has(titleId)) {
        set.add(titleId);
        awardCounts[titleId] = (awardCounts[titleId] ?? 0) + 1;
      }
    };

    const playerStats = await prismaClient.playerStats.findMany({
      include: { player: { select: { id: true, latestIGN: true } } },
    });

    const lifetimeStats = new Map<string, { wins: number; losses: number }>();
    for (const stats of playerStats) {
      const playerId = stats.playerId;
      const current = lifetimeStats.get(playerId) ?? { wins: 0, losses: 0 };
      current.wins += stats.wins;
      current.losses += stats.losses;
      lifetimeStats.set(playerId, current);
    }

    const mvpParticipations = await prismaClient.gameParticipation.findMany({
      where: { mvp: true },
      select: { playerId: true },
    });
    const mvpCounts = new Map<string, number>();
    for (const row of mvpParticipations) {
      mvpCounts.set(row.playerId, (mvpCounts.get(row.playerId) ?? 0) + 1);
    }

    const captainParticipations = await prismaClient.gameParticipation.findMany(
      {
        where: { captain: true },
        select: {
          playerId: true,
          team: true,
          game: { select: { winner: true } },
        },
      }
    );
    const captainWinCounts = new Map<string, number>();
    for (const row of captainParticipations) {
      if (row.game?.winner === row.team) {
        captainWinCounts.set(
          row.playerId,
          (captainWinCounts.get(row.playerId) ?? 0) + 1
        );
      }
    }

    const players = await prismaClient.player.findMany({
      select: { id: true, latestIGN: true },
    });
    const playerByIgn = new Map<string, string>();
    for (const player of players) {
      if (player.latestIGN) {
        playerByIgn.set(player.latestIGN.toLowerCase(), player.id);
      }
    }

    const hostCounts = new Map<string, number>();
    const games = await prismaClient.game.findMany({
      select: { organiser: true, host: true },
    });
    for (const game of games) {
      const organiserId = playerByIgn.get(game.organiser.toLowerCase());
      const hostId = playerByIgn.get(game.host.toLowerCase());
      if (organiserId) {
        hostCounts.set(organiserId, (hostCounts.get(organiserId) ?? 0) + 1);
      }
      if (hostId) {
        hostCounts.set(hostId, (hostCounts.get(hostId) ?? 0) + 1);
      }
    }

    const seasons = await prismaClient.season.findMany({
      select: { id: true, number: true },
      orderBy: { number: "asc" },
    });
    for (const season of seasons) {
      const seasonStats = playerStats
        .filter((s) => s.seasonId === season.id)
        .sort((a, b) => b.elo - a.elo);
      seasonStats.forEach((stats, idx) => {
        const rank = idx + 1;
        if (rank === 1) ensureAward(stats.playerId, "CHAMPION");
        if (rank <= 2) ensureAward(stats.playerId, "ACE");
        if (rank <= 3) ensureAward(stats.playerId, "ELITE");
      });
    }

    for (const [playerId, stats] of lifetimeStats) {
      const gamesPlayed = stats.wins + stats.losses;
      if (stats.wins >= 200) ensureAward(playerId, "WARFORGED");
      if (gamesPlayed >= 250) ensureAward(playerId, "VETERAN");
    }

    for (const [playerId, count] of mvpCounts) {
      if (count >= 10) ensureAward(playerId, "PARAGON");
    }

    for (const [playerId, count] of captainWinCounts) {
      if (count >= 10) ensureAward(playerId, "COMMODORE");
    }

    for (const [playerId, count] of hostCounts) {
      if (count >= 100) ensureAward(playerId, "OVERSEER");
    }

    const profileModel = getProfileModel();
    let updatedPlayers = 0;
    if (profileModel) {
      for (const [playerId, awards] of awardsByPlayer) {
        const existing = await profileModel.findUnique({
          where: { playerId },
        });
        const data = existing as { unlockedTitles?: string[] } | null;
        const merged = new Set([...(data?.unlockedTitles ?? []), ...awards]);
        const newlyEarned = Array.from(awards).filter(
          (id) => !(data?.unlockedTitles ?? []).includes(id)
        );
        await profileModel.upsert({
          where: { playerId },
          update: { unlockedTitles: Array.from(merged) },
          create: { playerId, unlockedTitles: Array.from(merged) },
        });
        if (newlyEarned.length) {
          console.log(
            `[TitlesUpdate] playerId=${playerId} earned=${newlyEarned.join(", ")}`
          );
        }
        updatedPlayers += 1;
      }
    }

    const awardSummary = Object.entries(awardCounts)
      .map(([id, count]) => `${id}: ${count}`)
      .join(", ");

    return `Titles update complete. Players updated: ${updatedPlayers}. Awards: ${
      awardSummary || "none"
    }.`;
  }
}
