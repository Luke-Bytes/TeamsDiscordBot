import { Channels } from "../Channels";
import { Message } from "discord.js";
import EventEmitter from "events";
import { Scheduler } from "../util/SchedulerUtil";
import { GameInstance } from "../database/GameInstance";
//TODO this should be all made into reusable functions later
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

    const answers = this.pollMessage.poll?.answers;
    if (!answers || answers.size === 0) {
      console.log("No answers found.");
      return;
    }

    const answersArray = Array.from(answers.entries());
    console.log(
      JSON.stringify(
        answersArray.map(([key, value]) => ({
          Key: key,
          Text: value?.text ?? "N/A",
          VoteCount: value?.voteCount ?? 0,
          RawData: JSON.stringify(value),
        })),
        null,
        2
      )
    );

    const winningEntry = answersArray.reduce(
      (prev, current) =>
        current[1].voteCount > prev[1].voteCount ? current : prev,
      answersArray[0]
    );

    const answer = winningEntry[1]?.text === "Yes";

    console.log(
      JSON.stringify(
        {
          Minerushing: winningEntry ?? "None found",
          VoteCount: winningEntry[1].voteCount,
        },
        null,
        2
      )
    );

    this.emit("pollEnd", answer);
  }

  async startMinerushVote() {
    const channel = Channels.announcements;

    if (!channel || !channel.isSendable()) {
      console.error(`Missing send permissions in channel ${channel}`);
      return;
    }

    this.pollMessage = await channel.send({
      poll: {
        question: { text: "Minerushing Vote" },
        answers: [
          { text: "Yes", emoji: "✅" },
          { text: "No", emoji: "❌" },
        ],
        duration: 48,
        allowMultiselect: false,
      },
    });

    const gameStartTime = GameInstance.getInstance().startTime;
    if (!gameStartTime) {
      console.error("Game start time is not set.");
      return;
    }

    const fiveMinutesBeforeStart = new Date(
      gameStartTime.getTime() - 5 * 60 * 1000
    );
    const now = new Date();

    if (fiveMinutesBeforeStart > now) {
      const delay = fiveMinutesBeforeStart.getTime() - now.getTime();
      console.info(
        `Scheduling minerush poll closure in ${delay / 1000}s at ${fiveMinutesBeforeStart.toISOString()}`
      );

      Scheduler.schedule(
        "minerushVote",
        async () => {
          console.info(
            `Finalizing minerush vote at ${new Date().toISOString()}`
          );
          await this.finalizeVotes();
        },
        fiveMinutesBeforeStart
      );
    } else {
      console.warn(
        "[WARN] Game start time already passed or is within 5 minutes."
      );
    }
  }

  async cancelVote() {
    if (this.pollMessage) {
      Scheduler.cancel("minerushVote");
      await this.pollMessage.delete();
      this.pollMessage = undefined;

      console.info("Minerush vote and its scheduler have been canceled.");
    } else {
      console.warn("No poll message to delete or cancel.");
    }
  }
}
