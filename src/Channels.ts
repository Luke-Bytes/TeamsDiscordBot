import { ConfigManager } from "ConfigManager";
import { error } from "console";
import { Client, GuildBasedChannel } from "discord.js";

export class Channels {
  public static announcements: GuildBasedChannel;

  public static async initChannels(client: Client) {
    //TODO add other channels like registration and organiser-commands etc
    const config = ConfigManager.getConfig();
    const fetchedAnnouncements = await client.channels.fetch(
      config.channels.announcements
    );

    if (fetchedAnnouncements === null) {
      error("Could not find announcements channel!");
      return;
    }

    this.announcements = fetchedAnnouncements as GuildBasedChannel;
  }
}
