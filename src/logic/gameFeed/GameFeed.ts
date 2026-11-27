import { TextChannel, EmbedBuilder, APIEmbed } from "discord.js";
import { isUnknownMessage } from "../../util/DiscordFailures";

type FeedMessage = {
  id?: string;
  type: string;
  updateFn: () => Promise<EmbedBuilder>;
  /** Last successful Discord publication; scoped to this in-memory feed entry. */
  published?: string;
};

type FeedRun = { interval: NodeJS.Timeout; update: () => Promise<void> };

// Compare author-controlled content, not Discord-generated type, proxy URLs,
// image dimensions or the optional inline flag's representation.
function comparableEmbed(embed: APIEmbed): string {
  return JSON.stringify({
    title: embed.title,
    description: embed.description,
    url: embed.url,
    color: embed.color,
    timestamp: embed.timestamp ? Date.parse(embed.timestamp) : undefined,
    author: embed.author && {
      name: embed.author.name,
      url: embed.author.url,
      icon_url: embed.author.icon_url,
    },
    footer: embed.footer && {
      text: embed.footer.text,
      icon_url: embed.footer.icon_url,
    },
    image: embed.image?.url,
    thumbnail: embed.thumbnail?.url,
    fields: (embed.fields ?? []).map(({ name, value, inline }) => ({
      name, value, inline: inline ?? false,
    })),
  });
}

class GameFeed {
  private readonly feedMessages: Map<string, FeedMessage[]> = new Map();
  private readonly updateIntervals = new Map<string, FeedRun>();
  private readonly managedChannels: Set<string> = new Set();
  private readonly updatesInFlight = new Set<string>();
  private readonly pendingStarts = new Map<string, FeedRun>();

  async startFeed(channel: TextChannel): Promise<void> {
    if (this.updateIntervals.has(channel.id)) return;
    this.managedChannels.add(channel.id);

    const isCurrent = () => this.updateIntervals.get(channel.id) === run;
    const update = async () => {
      if (!isCurrent() || this.updatesInFlight.has(channel.id)) return;
      this.updatesInFlight.add(channel.id);
      try {
        const feedData = this.feedMessages.get(channel.id);
        if (!feedData) return;

        // Sequential processing keeps newly published feed messages in order.
        for (const feed of feedData) {
          const isActive = () =>
            isCurrent() && this.feedMessages.get(channel.id)?.includes(feed);
          if (!isCurrent()) break;
          if (!isActive()) continue;
          try {
            const embed = await feed.updateFn();
            if (!isActive()) continue;
            const payload = embed.toJSON();
            const content = JSON.stringify(payload);
            if (feed.id) {
              try {
                if (feed.published === content) {
                  // Verify existence and content even when the local cache is stale.
                  const message = await channel.messages.fetch({ message: feed.id, force: true });
                  if (!isActive()) continue;
                  if (message.embeds.length === 1 &&
                      comparableEmbed(message.embeds[0].toJSON()) === comparableEmbed(payload)) continue;
                }
                // Editing by ID verifies existence without a preceding GET
                // when our generated content changed.
                await channel.messages.edit(feed.id, { embeds: [embed] });
                if (isActive()) feed.published = content;
                continue;
              } catch (error) {
                // Only Discord's explicit Unknown Message proves deletion.
                if (!isUnknownMessage(error)) throw error;
              }
            }
            if (!isActive()) continue;
            feed.id = undefined;
            feed.published = undefined;
            const newMessage = await channel.send({ embeds: [embed] });
            if (isActive()) {
              feed.id = newMessage.id;
              feed.published = content;
            } else {
              // Stop or removal occurred while Discord was sending.
              await newMessage.delete().catch((error) =>
                console.error("Failed to remove stopped game-feed message:", error)
              );
            }
          } catch (error) {
            // One unavailable message must not starve the other feed entries.
            console.error(`Game-feed update failed channel=${channel.id} type=${feed.type}:`, error);
          }
        }
      } finally {
        this.updatesInFlight.delete(channel.id);
        const pending = this.pendingStarts.get(channel.id);
        this.pendingStarts.delete(channel.id);
        if (pending && this.updateIntervals.get(channel.id) === pending) {
          // A replacement run was waiting for this run (including orphan cleanup).
          await pending.update();
        }
      }
    };
    const run: FeedRun = {
      interval: setInterval(() => { void update(); }, 20000),
      update,
    };
    this.updateIntervals.set(channel.id, run);

    if (this.updatesInFlight.has(channel.id)) {
      // Do not block lifecycle operations on a stopped generation's Discord I/O.
      this.pendingStarts.set(channel.id, run);
    } else {
      await update();
    }
  }

  stopFeed(channel: TextChannel): void {
    this.stopChannel(channel.id);
  }

  private stopChannel(channelId: string): void {
    const run = this.updateIntervals.get(channelId);
    if (run) clearInterval(run.interval);
    this.updateIntervals.delete(channelId);
    this.pendingStarts.delete(channelId);
    this.feedMessages.delete(channelId);
    this.managedChannels.delete(channelId);
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
      this.stopChannel(channelId);
    }
    console.log("Removed all feed message updaters.");
  }
}

export const gameFeed = new GameFeed();
