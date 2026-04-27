import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  EmbedBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { Channels } from "../Channels";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { TitleStore } from "../util/TitleStore";
import { PrismaUtils } from "../util/PrismaUtils";
import { prismaClient } from "../database/prismaClient";
import { DiscordUtil } from "../util/DiscordUtil";
import { formatTitleLabel } from "../util/ProfileUtil";
import { escapeText } from "../util/Utils";

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
type TitlesUpdateSnapshot = {
  awardsByPlayer: Map<string, Set<string>>;
  awardCounts: AwardCounts;
  ignByPlayerId: Map<string, string>;
  snowflakeByPlayerId: Map<string, string>;
  summary: string;
};
type NewlyUnlockedTitle = {
  playerId: string;
  ign: string;
  discordSnowflake: string | null;
  titleIds: string[];
};
type TitlesUpdateResult = {
  summary: string;
  newlyUnlocked: NewlyUnlockedTitle[];
};

export default class ScriptsCommand implements Command {
  name = "scripts";
  description = "Run organiser scripts";
  buttonIds: string[] = ["scripts-confirm", "scripts-cancel"];
  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addSubcommand((sub) =>
      sub
        .setName("titles-update")
        .setDescription("Award titles based on lifetime stats")
    );

  private readonly pendingByMessage = new Map<
    string,
    {
      userId: string;
      script: "titles-update";
      snapshot: TitlesUpdateSnapshot;
    }
  >();
  private readonly pendingByUser = new Map<
    string,
    { script: "titles-update"; snapshot: TitlesUpdateSnapshot }
  >();

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const isAuthorized = await PermissionsUtil.isUserAuthorised(interaction);
    if (!isAuthorized) return;

    const sub = interaction.options.getSubcommand();
    if (sub === "titles-update") {
      const snapshot = await this.runTitlesUpdate({ dryRun: true });
      const embed = new EmbedBuilder()
        .setTitle("Confirm Titles Update")
        .setDescription(snapshot.summary);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("scripts-confirm:titles-update")
          .setLabel("Confirm")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("scripts-cancel")
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
      );

      const message = await DiscordUtil.replyWithMessage(interaction, {
        embeds: [embed],
        components: [row],
      });
      if (message?.id) {
        this.pendingByMessage.set(message.id, {
          userId: interaction.user.id,
          script: "titles-update",
          snapshot,
        });
      }
      this.pendingByUser.set(interaction.user.id, {
        script: "titles-update",
        snapshot,
      });
      return;
    }

    await interaction.reply({
      content: "Unknown script.",
    });
  }

  async handleButtonPress(interaction: ButtonInteraction): Promise<void> {
    const pending =
      this.pendingByMessage.get(interaction.message.id) ??
      (this.pendingByUser.get(interaction.user.id)
        ? {
            userId: interaction.user.id,
            script: this.pendingByUser.get(interaction.user.id)!.script,
            snapshot: this.pendingByUser.get(interaction.user.id)!.snapshot,
          }
        : undefined);
    if (!pending) {
      await interaction.reply({
        content: "This confirmation has expired.",
      });
      return;
    }
    if (interaction.user.id !== pending.userId) {
      await interaction.reply({
        content: "Only the user who requested this can confirm.",
      });
      return;
    }

    if (interaction.customId.startsWith("scripts-cancel")) {
      this.pendingByMessage.delete(interaction.message.id);
      this.pendingByUser.delete(interaction.user.id);
      await interaction.update({
        content: "Script cancelled.",
        embeds: [],
        components: [],
      });
      return;
    }

    if (interaction.customId === "scripts-confirm:titles-update") {
      await interaction.update({
        content: "Running titles update...",
        embeds: [],
        components: [],
      });
      const result = await this.applyTitlesUpdate(pending.snapshot);
      const announcementBlocks = this.buildTitlesAnnouncement(result);
      if (announcementBlocks.length) {
        for (const block of announcementBlocks) {
          await Channels.announcements.send(block);
        }
      }
      await interaction.editReply({
        content: `${result.summary}${
          announcementBlocks.length
            ? `\nAnnouncement posted to ${Channels.announcements}.`
            : "\nNo announcement posted because no new titles were unlocked."
        }`,
      });
      this.pendingByMessage.delete(interaction.message.id);
      this.pendingByUser.delete(interaction.user.id);
      return;
    }
  }

  private async runTitlesUpdate(_opts: {
    dryRun: boolean;
  }): Promise<TitlesUpdateSnapshot> {
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

    const captainParticipations =
      await PrismaUtils.safeFindCaptainParticipations();
    const captainWinCounts = new Map<string, number>();
    const captainGameCounts = new Map<string, number>();
    const captainUnknownTeamCounts = new Map<string, number>();
    for (const row of captainParticipations) {
      captainGameCounts.set(
        row.playerId,
        (captainGameCounts.get(row.playerId) ?? 0) + 1
      );
      const team =
        typeof row.team === "string" ? row.team.trim().toUpperCase() : null;
      const winner =
        typeof row.winner === "string" ? row.winner.trim().toUpperCase() : null;
      if (!team || (team !== "RED" && team !== "BLUE")) {
        captainUnknownTeamCounts.set(
          row.playerId,
          (captainUnknownTeamCounts.get(row.playerId) ?? 0) + 1
        );
        continue;
      }
      if (winner && winner === team) {
        captainWinCounts.set(
          row.playerId,
          (captainWinCounts.get(row.playerId) ?? 0) + 1
        );
      }
    }

    const players = await prismaClient.player.findMany({
      select: { id: true, latestIGN: true, discordSnowflake: true },
    });
    const playerByIgn = new Map<string, string>();
    const ignByPlayerId = new Map<string, string>();
    const snowflakeByPlayerId = new Map<string, string>();
    for (const player of players) {
      if (player.latestIGN) {
        playerByIgn.set(player.latestIGN.toLowerCase(), player.id);
        ignByPlayerId.set(player.id, player.latestIGN);
      }
      if (player.discordSnowflake) {
        snowflakeByPlayerId.set(player.id, player.discordSnowflake);
      }
    }

    const hostCounts = new Map<string, number>();
    const games = await PrismaUtils.safeFindGamesForHostOrganiserCounts();
    for (const game of games) {
      const organiserKey = game.organiser
        ? game.organiser.trim().toLowerCase()
        : null;
      const hostKey = game.host ? game.host.trim().toLowerCase() : null;
      const organiserId = organiserKey
        ? playerByIgn.get(organiserKey)
        : undefined;
      const hostId = hostKey ? playerByIgn.get(hostKey) : undefined;
      if (organiserId) {
        hostCounts.set(organiserId, (hostCounts.get(organiserId) ?? 0) + 1);
      }
      if (hostId) {
        hostCounts.set(hostId, (hostCounts.get(hostId) ?? 0) + 1);
      }
    }

    const debugPlayerIds = new Set<string>();
    for (const id of lifetimeStats.keys()) debugPlayerIds.add(id);
    for (const id of mvpCounts.keys()) debugPlayerIds.add(id);
    for (const id of captainGameCounts.keys()) debugPlayerIds.add(id);
    for (const id of hostCounts.keys()) debugPlayerIds.add(id);
    for (const playerId of debugPlayerIds) {
      const ign = ignByPlayerId.get(playerId) ?? "Unknown";
      const life = lifetimeStats.get(playerId) ?? { wins: 0, losses: 0 };
      const gamesPlayed = life.wins + life.losses;
      console.log(
        `[TitlesDebug] playerId=${playerId} ign=${ign} wins=${life.wins} losses=${life.losses} games=${gamesPlayed} mvp=${mvpCounts.get(playerId) ?? 0} captainGames=${captainGameCounts.get(playerId) ?? 0} captainUnknownTeam=${captainUnknownTeamCounts.get(playerId) ?? 0} captainWins=${captainWinCounts.get(playerId) ?? 0} hostOrOrganiser=${hostCounts.get(playerId) ?? 0}`
      );
    }

    const seasons = await prismaClient.season.findMany({
      where: { isActive: false },
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
      if (stats.wins >= 25) ensureAward(playerId, "UNYIELDING");
      if (stats.wins >= 50) ensureAward(playerId, "CARRY");
      if (gamesPlayed >= 100) ensureAward(playerId, "VETERAN");
    }

    for (const [playerId, count] of mvpCounts) {
      if (count >= 10) ensureAward(playerId, "PARAGON");
    }

    for (const [playerId, count] of captainWinCounts) {
      if (count >= 10) ensureAward(playerId, "COMMODORE");
    }

    for (const [playerId, count] of hostCounts) {
      if (count >= 25) ensureAward(playerId, "OVERSEER");
    }

    const snapshot: TitlesUpdateSnapshot = {
      awardsByPlayer,
      awardCounts,
      ignByPlayerId,
      snowflakeByPlayerId,
      summary: "",
    };

    const awardSummary = Object.entries(awardCounts)
      .map(([id, count]) => `${id}: ${count}`)
      .join(", ");

    snapshot.summary = `Titles update preview.\nPlayers to update: ${awardsByPlayer.size}.\nAwards: ${
      awardSummary || "none"
    }.`;
    for (const [playerId, awards] of awardsByPlayer) {
      const ign = ignByPlayerId.get(playerId) ?? "Unknown";
      console.log(
        `[TitlesPreview] playerId=${playerId} ign=${ign} earned=${Array.from(
          awards
        ).join(", ")}`
      );
    }
    return snapshot;
  }

  private async applyTitlesUpdate(
    snapshot: TitlesUpdateSnapshot
  ): Promise<TitlesUpdateResult> {
    const profileModel = getProfileModel();
    let updatedPlayers = 0;
    const newlyUnlocked: NewlyUnlockedTitle[] = [];
    if (profileModel) {
      for (const [playerId, awards] of snapshot.awardsByPlayer) {
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
          const ign = snapshot.ignByPlayerId.get(playerId) ?? "Unknown";
          newlyUnlocked.push({
            playerId,
            ign,
            discordSnowflake:
              snapshot.snowflakeByPlayerId.get(playerId) ?? null,
            titleIds: newlyEarned,
          });
          console.log(
            `[TitlesUpdate] playerId=${playerId} ign=${ign} earned=${newlyEarned.join(", ")}`
          );
        }
        updatedPlayers += 1;
      }
    }

    const awardSummary = Object.entries(snapshot.awardCounts)
      .map(([id, count]) => `${id}: ${count}`)
      .join(", ");

    return {
      summary: `Titles update complete.\nPlayers updated: ${updatedPlayers}.\nAwards: ${
        awardSummary || "none"
      }.`,
      newlyUnlocked,
    };
  }

  private buildTitlesAnnouncement(result: TitlesUpdateResult): string[] {
    if (!result.newlyUnlocked.length) return [];

    const titles = TitleStore.loadTitles();
    const totalTitles = result.newlyUnlocked.reduce(
      (sum, row) => sum + row.titleIds.length,
      0
    );
    const rows = result.newlyUnlocked
      .sort((a, b) => b.titleIds.length - a.titleIds.length)
      .map((row) => {
        const labels = row.titleIds
          .map((id) => formatTitleLabel(id, titles) ?? id)
          .map((label) => `**${escapeText(label)}**`)
          .join(", ");
        const awardee = row.discordSnowflake
          ? `<@${row.discordSnowflake}>`
          : `**${escapeText(row.ign)}**`;
        return `✦ ${awardee} unlocked ${labels}`;
      });

    const intro = [
      "🏷️ **New Titles Unlocked**",
      `${result.newlyUnlocked.length} player${
        result.newlyUnlocked.length === 1 ? "" : "s"
      } earned ${totalTitles} new title${totalTitles === 1 ? "" : "s"}.`,
      "A fresh batch of profile titles has been awarded. Wear them well.",
      "Use `/profilecreate` to choose and equip an unlocked title.",
    ].join("\n");

    return splitAnnouncementBlocks([intro, ...rows]);
  }
}

function splitAnnouncementBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= 1800) {
      current = next;
      continue;
    }
    if (current) blocks.push(current);
    current = line;
  }
  if (current) blocks.push(current);
  return blocks;
}
