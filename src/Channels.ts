import { Client, TextChannel } from "discord.js";
import { ConfigManager } from "./ConfigManager";

export class Channels {
  public static announcements: TextChannel;
  public static teamPicking: TextChannel;
  public static gameFeed: TextChannel;
  public static registration: TextChannel;
  public static redTeamChat: TextChannel;
  public static blueTeamChat: TextChannel;

  public static async initChannels(client: Client) {
    const config = ConfigManager.getConfig();

    const fetchedAnnouncements = await client.channels.fetch(
      config.channels.announcements
    );
    this.announcements = fetchedAnnouncements as TextChannel;

    const fetchedTeamPicking = await client.channels.fetch(
      config.channels.teamPickingChat
    );
    this.teamPicking = fetchedTeamPicking as TextChannel;

    const fetchedGameFeed = await client.channels.fetch(
      config.channels.gameFeed
    );
    this.gameFeed = fetchedGameFeed as TextChannel;

    const fetchedRegistration = await client.channels.fetch(
      config.channels.registration
    );
    this.registration = fetchedRegistration as TextChannel;

    const fetchedRedTeamChat = await client.channels.fetch(
      config.channels.redTeamChat
    );
    this.redTeamChat = fetchedRedTeamChat as TextChannel;

    const fetchedBlueTeamChat = await client.channels.fetch(
      config.channels.blueTeamChat
    );
    this.blueTeamChat = fetchedBlueTeamChat as TextChannel;
  }
}
