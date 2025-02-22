import { TextChannel, EmbedBuilder } from "discord.js";

type FeedMessage = {
  id?: string;
  type: string;
  updateFn: () => Promise<EmbedBuilder>;
};

class GameFeed {
  private readonly feedMessages: Map<string, FeedMessage[]> = new Map();
  private readonly updateIntervals: Map<string, NodeJS.Timeout> = new Map();
  private readonly managedChannels: Set<string> = new Set();

  async startFeed(channel: TextChannel): Promise<void> {
    if (this.updateIntervals.has(channel.id)) return;
    this.managedChannels.add(channel.id);

    const update = async () => {
      const feedData = this.feedMessages.get(channel.id);
      if (!feedData) return;

      await Promise.all(
        feedData.map(async (feed) => {
          const embed = await feed.updateFn();
          if (feed.id) {
            const message = await channel.messages
              .fetch(feed.id)
              .catch(() => null);
            if (message) {
              await message.edit({ embeds: [embed] });
            } else {
              const newMessage = await channel.send({ embeds: [embed] });
              feed.id = newMessage.id;
            }
          } else {
            const newMessage = await channel.send({ embeds: [embed] });
            feed.id = newMessage.id;
          }
        })
      );
    };
    const intervalId = setInterval(update, 20000);
    this.updateIntervals.set(channel.id, intervalId);

    await update();
  }

  stopFeed(channel: TextChannel): void {
    const intervalId = this.updateIntervals.get(channel.id);
    if (intervalId) {
      clearInterval(intervalId);
      this.updateIntervals.delete(channel.id);
    }
    this.feedMessages.delete(channel.id);
  }

  addFeedMessage(
    channel: TextChannel,
    type: string,
    updateFn: () => Promise<EmbedBuilder>
  ): void {
    const feedData = this.feedMessages.get(channel.id) || [];
    feedData.push({ type, updateFn });
    this.feedMessages.set(channel.id, feedData);
  }

  removeFeedMessage(channel: TextChannel, type: string): void {
    const feedData = this.feedMessages.get(channel.id);
    if (!feedData) return;

    const updatedData = feedData.filter((feed) => feed.type !== type);
    this.feedMessages.set(channel.id, updatedData);
  }

  removeAllFeedMessages(): void {
    for (const channelId of this.managedChannels) {
      console.log(`Removing managed channel: ${channelId}`);

      const intervalId = this.updateIntervals.get(channelId);
      if (intervalId) clearInterval(intervalId);

      this.feedMessages.delete(channelId);
      this.updateIntervals.delete(channelId);
    }
    console.log("Removed all feed message updaters.");
    this.managedChannels.clear();
  }
}

export const gameFeed = new GameFeed();
