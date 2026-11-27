import { Guild } from "discord.js";
import { prismaClient } from "../database/prismaClient";

/**
 * Best-effort follow-up to a successful registration. A failure to change a
 * Discord nickname must never roll back or obscure the roster registration.
 */
export async function syncRegistrationNickname(
  guild: Guild,
  discordUserId: string,
  registeredIgn: string,
  knownPlayerId?: string
): Promise<"updated" | "skipped" | "failed"> {
  try {
    // Re-read the preference after registration so a recently changed opt-out
    // is respected, including for members registered by an organiser.
    if (!registeredIgn) return "skipped";
    const playerId = knownPlayerId ?? (await prismaClient.player.byDiscordSnowflake(discordUserId))?.id;
    if (!playerId) return "skipped";

    // Profiles are optional. Missing profiles or unset preferences mean on.
    const profile = await prismaClient.profile.findUnique({
      where: { playerId },
      select: { autoNickname: true },
    });
    if (profile?.autoNickname === false) return "skipped";

    const member = await guild.members.fetch(discordUserId);
    if (member.nickname === registeredIgn) return "skipped";
    // Discord role hierarchy restrictions are an expected reason to skip sync.
    if (!member.manageable) return "skipped";

    await member.setNickname(registeredIgn, "Automatic IGN sync on /register");
    return "updated";
  } catch (error) {
    console.warn(
      `Automatic nickname sync failed for member=${discordUserId}`,
      error instanceof Error ? error.message : String(error)
    );
    return "failed";
  }
}
