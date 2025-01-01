import { TextChannel } from "discord.js";
import { gameFeed } from "../../logic/gameFeed/GameFeed";

export async function activateFeed(
  channel: TextChannel,
  addFeedMessageFn: (channel: TextChannel) => Promise<void>
): Promise<void> {
  await addFeedMessageFn(channel);
  await gameFeed.startFeed(channel);
}
