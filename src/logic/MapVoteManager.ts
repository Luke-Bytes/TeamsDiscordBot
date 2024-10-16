import { AnniMap } from "@prisma/client";
import { log } from "console";
import {
  EmbedBuilder,
  GuildBasedChannel,
  Message,
  PollLayoutType,
  Snowflake,
} from "discord.js";
import { prettifyName } from "Utils";

//todo: store these three maps somewhere else?
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

export class MapVoteManager {
  maps: AnniMap[];

  channel?: GuildBasedChannel;
  pollMessage?: Message;

  winnerCallback?: (winner: AnniMap) => void;

  constructor(maps: AnniMap[], channel: GuildBasedChannel) {
    this.maps = maps;

    this.channel = channel;
  }

  async finalizeVotes() {
    if (!this.pollMessage) return;

    this.pollMessage.poll?.end();

    const winningMap =
      emojiToMaps[
        this.pollMessage.poll?.answers
          .sorted((firstValue, secondValue, firstKey, secondKey) => {
            return secondKey - firstKey;
          })
          .first()?.emoji?.name!
      ];

    log(winningMap);

    if (this.winnerCallback) this.winnerCallback(winningMap as AnniMap);
  }

  async startMapVote(winnerCallback: (winner: AnniMap) => void) {
    if (!this.channel) return;
    if (!this.channel.isSendable()) {
      console.error(`Missing send permissions in channel ${this.channel.name}`);
      return;
    }

    this.pollMessage = await this.channel.send({
      poll: {
        question: {
          text: "Map vote",
        },
        answers: this.maps.map((v) => {
          return {
            text: prettifyName(v),
            emoji: mapToEmojis[v],
          };
        }),
        duration: 1,
        allowMultiselect: false,
      },
    });

    this.winnerCallback = winnerCallback;

    const etaMs = this.pollMessage.poll!.expiresAt.getTime() - Date.now();

    setTimeout(() => {
      this.finalizeVotes();
    }, 2000);

    log(etaMs);
  }

  async cancelMapVote() {
    if (this.pollMessage) {
      this.pollMessage.delete();
    }
  }
}
