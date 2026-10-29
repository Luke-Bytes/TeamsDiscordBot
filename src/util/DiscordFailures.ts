import { Guild, GuildMember } from "discord.js";

export function discordErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "number" ? value : undefined;
}

export function isUnknownMessage(error: unknown): boolean {
  return discordErrorCode(error) === 10008;
}

export function isUnknownInteraction(error: unknown): boolean {
  return discordErrorCode(error) === 10062;
}

/** Only an explicit Discord 10007 proves that a member has left. */
export async function fetchGuildMember(
  guild: Guild,
  userId: string
): Promise<GuildMember | null> {
  try {
    const member = await guild.members.fetch({ user: userId, force: true });
    // A mock returning undefined is not evidence of a departure.
    if (!member) throw new Error(`Guild member lookup returned no result: ${userId}`);
    return member;
  } catch (error) {
    if (discordErrorCode(error) === 10007) return null;
    throw error;
  }
}

export async function withObsoleteMessageGuard(
  operation: "edit" | "delete",
  message: { id?: string; channelId?: string },
  action: () => Promise<unknown>
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (isUnknownMessage(error)) {
      console.warn(`Obsolete Discord message missing operation=${operation} channel=${message.channelId ?? "unknown"} message=${message.id ?? "unknown"} code=10008`);
      return;
    }
    throw error;
  }
}
