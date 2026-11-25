import { Guild } from "discord.js";
import { prismaClient } from "../database/prismaClient";

/**
 * Best-effort follow-up to a successful registration. A failure to change a
 * Discord nickname must never roll back or obscure the roster registration.
 */
export async function syncRegistrationNickname(
  guild: Guild,
  discordUserId: string,
  registeredIgn: string
): Promise<"updated" | "skipped" | "failed"> {
  try {
    // Re-read the preference after registration so a recently changed opt-out
    // is respected, including for members registered by an organiser.
    const player = await prismaClient.player.byDiscordSnowflake(discordUserId);
    if (!player || !registeredIgn) return "skipped";

    // Profiles are optional. Missing profiles or unset preferences mean on.
    const profile = await prismaClient.profile.findUnique({
      where: { playerId: player.id },
      select: { autoNickname: true },
    });
    if (profile?.autoNickname === false) return "skipped";

    const member = await guild.members.fetch(discordUserId);
    if (member.nickname === registeredIgn) return "skipped";
    if (!member.manageable) return "failed";

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
