import { TextChannel, Message, EmbedBuilder } from "discord.js";

type FeedMessage = {
  id?: string;
  type: string;
  updateFn: () => Promise<EmbedBuilder>;
};

class GameFeed {
  private feedMessages: Map<string, FeedMessage[]> = new Map();
  private updateIntervals: Map<string, NodeJS.Timeout> = new Map();
  private managedChannels: Set<string> = new Set();

  async startFeed(channel: TextChannel): Promise<void> {
    if (this.updateIntervals.has(channel.id)) return;
    this.managedChannels.add(channel.id);

    const update = async () => {
      const feedData = this.feedMessages.get(channel.id);
      if (!feedData) return;

      for (const feed of feedData) {
        const embed = await feed.updateFn();

        if (feed.id) {
          const message = await channel.messages
            .fetch(feed.id)
            .catch(() => null);
          if (message) {
            await message.edit({ embeds: [embed] });
          } else {
            // Message might have been deleted, reinitialize
            const newMessage = await channel.send({ embeds: [embed] });
            feed.id = newMessage.id;
          }
        } else {
          const newMessage = await channel.send({ embeds: [embed] });
          feed.id = newMessage.id;
        }
      }
    };

    const intervalId = setInterval(update, 10000); // Update every 10 seconds
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
