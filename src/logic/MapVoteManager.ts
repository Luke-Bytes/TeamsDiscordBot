import { AnniMap } from "@prisma/client";
import { Channels } from "Channels";
import { error, log } from "console";
import { Message } from "discord.js";
import EventEmitter from "events";
import { prettifyName } from "Utils";

//todo: store these three maps somewhere else?
const mapToEmojis: Record<AnniMap, string> = {
  AFTERMATH1V1: "🕸️",
  ANDORRA1V1: "🏔️",
  ARID1V1: "❓",
  CANYON1V1: "🏜️",
  CHASM1V1: "🏝️",
  CHEROKEE1V1: "🎌",
  DREDGE1V1: "🧙",
  DUELSTAL: "💫 ",
  NATURE1V1: "🌲 ",
  SIEGE1V1: "🪄",
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

    const winningMap = Object.entries(mapToEmojis).find(
      (v) =>
        v[1] ===
        this.pollMessage?.poll?.answers
          .sorted((_firstAnswer, _secondAnswer, firstCount, secondCount) => {
            return secondCount - firstCount;
          })
          .first()?.emoji?.name
    )?.[0];

    if (!winningMap) {
      error("Could not find winning map!");
      return;
    }

    this.emit("pollEnd", winningMap as AnniMap);
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
