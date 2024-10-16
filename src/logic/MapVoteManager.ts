import { AnniMap } from "@prisma/client";
import { Channels } from "Channels";
import { log } from "console";
import {
  EmbedBuilder,
  GuildBasedChannel,
  Message,
  PollLayoutType,
  Snowflake,
} from "discord.js";
import EventEmitter from "events";
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

interface MapVoteManagerEvents {
  pollEnd: [winningMap: AnniMap];
}

export class MapVoteManager extends EventEmitter<MapVoteManagerEvents> {
  maps: AnniMap[];

  pollMessage?: Message;

  constructor(maps: AnniMap[]) {
    super();
    this.maps = maps;
  }

  async finalizeVotes() {
    if (!this.pollMessage) return;

    this.pollMessage.poll?.end();

    const winningMap =
      emojiToMaps[
        this.pollMessage.poll?.answers
          //todo better naming, kinda confusing
          .sorted((firstValue, secondValue, firstKey, secondKey) => {
            return secondKey - firstKey;
          })
          .first()?.emoji?.name!
      ];

    this.emit("pollEnd", winningMap);
  }

  async startMapVote() {
    const channel = Channels.announcements;
    if (!channel) return;
    if (!channel.isSendable()) {
      console.error(`Missing send permissions in channel ${channel.name}`);
      return;
    }

    this.pollMessage = await channel.send({
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

    const etaMs = this.pollMessage.poll!.expiresAt.getTime() - Date.now();

    setTimeout(() => {
      this.finalizeVotes();
    }, etaMs);
  }

  async cancelVote() {
    if (this.pollMessage) {
      this.pollMessage.delete();
    }
  }
}
