import { Channels } from "../Channels";
import { Message } from "discord.js";
import EventEmitter from "events";
import { Scheduler } from "../util/SchedulerUtil";
import { GameInstance } from "../database/GameInstance";

interface TeamsVoteManagerEvents {
  pollEnd: [answer: boolean];
}

export class TeamsVoteManager extends EventEmitter<TeamsVoteManagerEvents> {
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
          Teams: winningEntry ?? "None found",
          VoteCount: winningEntry[1].voteCount,
        },
        null,
        2
      )
    );

    this.emit("pollEnd", answer);
  }

  async startTeamsVote() {
    console.log("Starting 4-Team Game vote...");
    const channel = Channels.announcements;

    if (!channel || !channel.isSendable()) {
      console.error(`Missing send permissions in channel ${channel}`);
      return;
    }

    await channel.send({
      content:
        "40 players have registered for the friendly war! Should this game have 4 teams instead of 2?",
    });

    this.pollMessage = await channel.send({
      poll: {
        question: { text: "4-Team Game Vote (1v1v1v1)" },
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
        `Scheduling 4-Team Game poll closure in ${delay / 1000}s at ${fiveMinutesBeforeStart.toISOString()}`
      );

      Scheduler.schedule(
        "4teamVote",
        async () => {
          console.info(
            `Finalizing 4-Team Game vote at ${new Date().toISOString()}`
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
      Scheduler.cancel("4teamVote");
      await this.pollMessage.delete();
      this.pollMessage = undefined;

      console.info("4-Team Game vote and its scheduler have been canceled.");
    } else {
      console.warn("No poll message to delete or cancel.");
    }
  }

  async stopVote() {
    Scheduler.cancel("4teamVote");
    if (this.pollMessage) {
      console.info("4-Team Game voting has been ended.");
      this.pollMessage.poll?.end();
    }
  }
}
