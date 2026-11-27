import { Guild } from "discord.js";
import { prismaClient } from "../database/prismaClient";
import { MinecraftNameLookup, MojangAPI } from "../api/MojangAPI";
import { fetchGuildMember } from "../util/DiscordFailures";
import { escapeText } from "../util/Utils";

/** Shared read-only IGN verification for organiser commands. */
export async function verifyIGN(
  name: string,
  guild: Guild | null,
  ping: boolean,
  mentionableUserIds: string[],
  existingLookup?: MinecraftNameLookup,
  referenceUUID?: string
): Promise<string[]> {
  const escapedName = escapeText(name);
  const lookup = existingLookup ?? (await MojangAPI.lookupUsername(name));
  if (lookup.status === "invalid") {
    return [`❌ **${escapedName}** – Invalid Minecraft username format`];
  }
  if (lookup.status === "unavailable") {
    return [`⚠️ **${escapedName}** – Verification service unavailable; account status is unknown`];
  }
  if (lookup.status === "notFound") {
    const possible = await prismaClient.player.findMany({
      where: { minecraftAccounts: { has: name } },
    });
    const matches = possible.filter((p) =>
      p.minecraftAccounts.some(
        (acc) => acc.toLowerCase() === name.toLowerCase()
      )
    );

    if (!matches.length) {
      return [`❓ **${escapedName}** – Username not found on Mojang`];
    }
    const results: string[] = [];
    for (const match of matches) {
      const currentName =
        (await MojangAPI.uuidToUsername(match.primaryMinecraftAccount ?? "")) ??
        match.latestIGN ??
        "Unknown IGN";
      const authorTag = await memberLabel(
        guild,
        match.discordSnowflake,
        ping,
        mentionableUserIds
      );
      results.push(
        `❓ **${escapedName}** – Username not found on Mojang; historical match: ${authorTag}, latest IGN: **${escapeText(currentName)}**`
      );
    }
    return results;
  }

  const relation = referenceUUID
    ? lookup.uuid.toLowerCase() === referenceUUID.toLowerCase()
      ? " · Same Minecraft account"
      : " · Different Minecraft account"
    : "";
  const player = await prismaClient.player.findFirst({
    where: { primaryMinecraftAccount: lookup.uuid },
  });

  if (!player) {
    return [
      `⛔ **${escapedName}** – Valid username but not registered in database${relation}`,
    ];
  }

  const authorTag = await memberLabel(
    guild,
    player.discordSnowflake,
    ping,
    mentionableUserIds
  );

  const latest = player.latestIGN;
  if (latest && name.toLowerCase() !== latest.toLowerCase()) {
    return [
      `✅ **${escapedName}** – ${authorTag} - Name changed since they last registered from "${escapeText(latest)}"${relation}`,
    ];
  }
  return [`✅ **${escapedName}** – ${authorTag}${relation}`];
}

async function memberLabel(
  guild: Guild | null,
  id: string,
  ping: boolean,
  mentions: string[]
): Promise<string> {
  if (!guild) return escapeText(`@${id} (guild membership unknown)`);
  try {
    const member = await fetchGuildMember(guild, id);
    if (!member) return escapeText(`@${id} (no longer in server)`);
    if (ping) {
      mentions.push(id);
      return `<@${id}>`;
    }
    return escapeText(`@${member.user.tag}`);
  } catch (error) {
    console.warn(`Verify could not confirm guild membership member=${id}`, error);
    return escapeText(`@${id} (membership unverified)`);
  }
}
