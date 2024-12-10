import { Message, GuildMember } from "discord.js";

export class ReactionHandler {
  async addReaction(message: Message, emoji: string): Promise<void> {
    await message.react(emoji);
  }

  async getUsersWhoReacted(
    message: Message,
    emoji: string
  ): Promise<GuildMember[]> {
    const reaction = message.reactions.cache.get(emoji);
    if (!reaction || !message.guild) return [];

    const users = await reaction.users.fetch();
    const guildMembers: GuildMember[] = [];

    for (const user of users.values()) {
      const member = await message.guild.members
        .fetch(user.id)
        .catch(() => null);
      if (member) guildMembers.push(member);
    }

    return guildMembers;
  }

  async getReactionCount(message: Message, emoji: string): Promise<number> {
    const reaction = message.reactions.cache.get(emoji);
    return reaction?.count ?? 0;
  }
}
