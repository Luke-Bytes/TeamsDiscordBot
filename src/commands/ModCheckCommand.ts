import {
  ChatInputCommandInteraction,
  GuildMember,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { prismaClient } from "../database/prismaClient";
import { PrismaUtils } from "../util/PrismaUtils";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { escapeText } from "../util/Utils";
import { MojangAPI } from "../api/MojangAPI";
import { MinecraftNameHistoryAPI } from "../api/MinecraftNameHistoryAPI";
import { normalizeHistoryUUID } from "../api/NameHistoryTypes";
import { combinedHistorySummary } from "./NameHistoryPresentation";
import { inspectAccountConsistency } from "../logic/ModerationIssues";
import { verifyIGN } from "../logic/VerifyIGN";
import {
  buildModerationReview,
  observedMinecraftUUIDs,
  recordedMinecraftNames,
} from "../logic/ModerationReview";

export default class ModCheckCommand implements Command {
  name = "modcheck";
  description = "Review a player's moderation and account history (organisers only)";
  buttonIds: string[] = [];

  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("player")
        .setDescription("Current Minecraft IGN, Discord mention or Discord ID")
        .setRequired(true)
    );

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId ?? interaction.guild?.id;
    const member =
      interaction.guild?.members.cache.get(interaction.user.id) ??
      (await interaction.guild?.members
        .fetch(interaction.user.id)
        .catch(() => undefined));
    if (
      !guildId ||
      !PermissionsUtil.hasRole(
        member as GuildMember | undefined,
        "organiserRole"
      )
    ) {
      await interaction.reply({
        content: "Only an organiser can use this command in the server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const input = interaction.options.getString("player", true).trim();
    const identifier = input.replace(/^<@!?(\d+)>$/, "$1");

    try {
      const player = await PrismaUtils.findPlayer(identifier);
      if (!player) {
        await interaction.editReply(
          { content: `No registered player found for \`${escapeText(input)}\`.`, allowedMentions: { parse: [] } }
        );
        return;
      }

      // Only event snapshots from the invoking server count as evidence here.
      const [punishments, games, events] = await Promise.all([
        prismaClient.playerPunishment.findMany({
          where: { playerId: player.id },
        }),
        prismaClient.gameParticipation.findMany({
          where: { playerId: player.id },
          select: { ignUsed: true },
        }),
        prismaClient.standaloneEvent.findMany({
          where: { guildId },
          select: { id: true, state: true },
        }),
      ]);
      const eventIds = events.map((event) => event.id);
      const signups = eventIds.length
        ? await prismaClient.eventSignup.findMany({
            where: {
              eventId: { in: eventIds },
              discordUserId: player.discordSnowflake,
            },
            select: {
              eventId: true,
              status: true,
              discordUserId: true,
              minecraftUUID: true,
              minecraftUsername: true,
            },
          })
        : [];
      const uuids = observedMinecraftUUIDs(player, signups);
      const primaryUUID = normalizeHistoryUUID(player.primaryMinecraftAccount);
      const [
        overlappingPlayers,
        overlappingSignups,
        duplicateNames,
        liveLookup,
        externalHistory,
      ] = await Promise.all([
        uuids.length
          ? prismaClient.player.findMany({
              where: {
                NOT: { id: player.id },
                OR: [
                  { primaryMinecraftAccount: { in: uuids } },
                  { minecraftAccounts: { hasSome: uuids } },
                ],
              },
              select: {
                discordSnowflake: true,
                primaryMinecraftAccount: true,
                minecraftAccounts: true,
              },
            })
          : Promise.resolve([]),
        uuids.length && eventIds.length
          ? prismaClient.eventSignup.findMany({
              where: {
                eventId: { in: eventIds },
                minecraftUUID: { in: uuids, mode: "insensitive" },
                NOT: { discordUserId: player.discordSnowflake },
              },
              select: {
                discordUserId: true,
                minecraftUUID: true,
                minecraftUsername: true,
              },
            })
          : Promise.resolve([]),
        player.latestIGN && MojangAPI.validateUsername(player.latestIGN)
          ? prismaClient.player.findMany({
              where: {
                id: { not: player.id },
                latestIGN: { equals: player.latestIGN, mode: "insensitive" },
              },
              select: { discordSnowflake: true },
            })
          : Promise.resolve([]),
        MojangAPI.validUUID(player.primaryMinecraftAccount) &&
        player.latestIGN &&
        MojangAPI.validateUsername(player.latestIGN)
          ? MojangAPI.lookupUsername(player.latestIGN).catch(() => ({
              status: "unavailable" as const,
            }))
          : Promise.resolve(undefined),
        primaryUUID
          ? Promise.resolve().then(() => MinecraftNameHistoryAPI.lookupByUUID(primaryUUID, { guildId })).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      const activeEventIds = new Set(
        events
          .filter((event) => ["OPEN", "CLOSED"].includes(event.state))
          .map((event) => event.id)
      );
      const diagnostics = inspectAccountConsistency(
        player,
        punishments,
        signups.filter(
          (signup) =>
            activeEventIds.has(signup.eventId) &&
            ["CONFIRMED", "RESERVE"].includes(signup.status)
        ),
        overlappingPlayers,
        duplicateNames,
        liveLookup
      );

      const embed = buildModerationReview(
        player,
        punishments,
        games,
        signups,
        overlappingPlayers,
        overlappingSignups,
        diagnostics
      );
      const names = recordedMinecraftNames(player, games, signups);
      const selected = names.slice(0, 10);
      const verification: string[][] = [];
      // Bound external requests, and reuse the current IGN's consistency lookup.
      for (let i = 0; i < selected.length; i += 3) {
        verification.push(...await Promise.all(selected.slice(i, i + 3).map(async (name) => {
          try {
            return await verifyIGN(
              name,
              interaction.guild,
              false,
              [],
              name.toLowerCase() === player.latestIGN?.toLowerCase() ? liveLookup : undefined,
              primaryUUID
            );
          } catch {
            return [`⚠️ **${escapeText(name)}** – Verification unavailable`];
          }
        })));
      }
      const verificationField = "IGN verification (recorded names)";
      const verificationBudget = Math.min(1024, 6000 - embed.length - verificationField.length - 100);
      if (verificationBudget > 100) {
        const lines: string[] = [];
        let shown = 0;
        for (const group of verification) {
          if ([...lines, ...group].join("\n").length > verificationBudget - 90) break;
          lines.push(...group);
          shown++;
        }
        if (shown < names.length) {
          lines.push(`…${names.length - shown} more names; use /verify igns for details.`);
        }
        embed.addFields({
          name: verificationField,
          value: lines.join("\n") || "No recorded IGNs to verify.",
        });
      }
      const external = combinedHistorySummary(externalHistory, player.latestIGN);
      const fieldName = "Name history (linked account)";
      const available = Math.min(1024, 6000 - embed.length - fieldName.length);
      if (available > 100) {
        embed.addFields({ name: fieldName, value: external.length <= available ? external : external.slice(0, available - 1) + "…" });
      }
      await interaction.editReply({
        embeds: [embed],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error(
        "event=moderation.review outcome=failed",
        error instanceof Error ? error.name : "unknown"
      );
      await interaction.editReply(
        "Unable to complete the moderation review. No conclusions can be drawn from this attempt."
      );
    }
  }
}
