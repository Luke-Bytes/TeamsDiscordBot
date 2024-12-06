import { Channels } from "../Channels";
import { Message } from "discord.js";
import EventEmitter from "events";

interface MinerushVoteManagerEvents {
  pollEnd: [answer: boolean];
}

export class MinerushVoteManager extends EventEmitter<MinerushVoteManagerEvents> {
  pollMessage?: Message;

  constructor() {
    super();
  }

  async finalizeVotes() {
    if (!this.pollMessage) return;

    this.pollMessage.poll?.end();

    const answer =
      this.pollMessage.poll?.answers
        .sorted((firstValue, secondValue, firstKey, secondKey) => {
          return secondKey - firstKey;
        })
        .first()?.text === "Yes";

    this.emit("pollEnd", answer);
  }

  async startMinerushVote() {
    const channel = Channels.announcements;

    if (!channel) return;
    if (!channel.isSendable()) {
      console.error(`Missing send permissions in channel ${channel.name}`);
      return;
    }

    this.pollMessage = await channel.send({
      poll: {
        question: {
          text: "Minerushing Vote",
        },
        answers: [
          {
            text: "Yes",
            emoji: "✅",
          },
          {
            text: "No",
            emoji: "❌",
          },
        ],
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
