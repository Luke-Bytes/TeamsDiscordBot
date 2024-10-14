import { AnniMap } from "@prisma/client";
import { log } from "console";
import { EmbedBuilder, GuildBasedChannel, Message } from "discord.js";

const mapToEmojis: Record<AnniMap, string> = {
  //TODO add relevant emojis
  COASTAL: "🌊",
  //Duelstal: "🗺️",
  //Clashstal: "🗺️",
  //Canyon: "🗺️",
  NATURE: "🍃",
  //Siege: "🗺️",
  //Andorra: "🗺️",
  //Arid: "🗺️",
  //Aftermath: "🗺️",
  //Dredge: "🗺️",
  //Villages: "🗺️",
  //Chasm: "🌍",
};

const emojiToMaps: Record<string, AnniMap> = {
  "🌊": "COASTAL",
  "🍃": "NATURE",
};

const prettyMapNames: Record<AnniMap, String> = {
  COASTAL: "Coastal",
  NATURE: "Nature",
};

export class MapVoteManager {
  votes: Partial<Record<AnniMap, number>> = {};
  maps: AnniMap[];

  started: boolean;
  channel?: GuildBasedChannel;
  message?: Message;

  voteTimeout?: NodeJS.Timeout;
  winnerCallback?: (winner: AnniMap) => void;

  constructor(maps: AnniMap[]) {
    this.maps = maps;
    this.started = false;
    maps.forEach((map) => {
      this.votes[map] = 0;
    });
  }

  async updateMapVotes() {
    this.message?.reactions.cache.forEach(async (reaction) => {
      if ((this.maps as string[]).includes(emojiToMaps[reaction.emoji.name!])) {
        const size = (await reaction.users.fetch()).size;
        this.votes[emojiToMaps[reaction.emoji.name!]] = size - 1;
      }
    });

    const embed = this.makeEmbed();

    await this.message?.edit({ embeds: [embed] });
  }

  async finalizeVotes() {
    clearTimeout(this.voteTimeout);
    this.updateMapVotes();

    const winningMap = Object.entries(this.votes).sort((a, b) => {
      return a[1] - b[1];
    })[0][0];

    if (this.winnerCallback) this.winnerCallback(winningMap as AnniMap);
  }

  makeEmbed() {
    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("**MAP VOTE**");

    this.maps.forEach((map) => {
      embed.addFields({
        name: prettyMapNames[map] + ": " + this.votes[map],
        value: " ",
        inline: false,
      });
    });

    return embed;
  }

  async startMapVote(
    channel: GuildBasedChannel,
    winnerCallback: (winner: AnniMap) => void
  ) {
    if (!channel.isSendable()) {
      console.error(`Missing send permissions in channel ${channel.name}`);
      return;
    }

    this.started = true;
    this.channel = channel;

    const initialEmbed = this.makeEmbed();

    this.message = await this.channel.send({
      embeds: [initialEmbed],
    });

    for (let i = 0; i < this.maps.length; i++) {
      await this.message.react(
        mapToEmojis[this.maps[i].toUpperCase() as AnniMap]
      );
    }

    let i = 0;
    let interval = 1000;
    this.winnerCallback = winnerCallback;
    this.voteTimeout = setInterval(async () => {
      await this.updateMapVotes();
      i += interval;

      //10 second vote
      if (i >= 10000) {
        await this.finalizeVotes();
      }
    }, interval);
  }

  async cancelMapVote() {
    if (this.message) {
      if (this.voteTimeout) {
        clearTimeout(this.voteTimeout);
      }
      this.message.delete();
    }
  }
}
