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
  private starting = false;
  private closed = false;

  constructor() {
    super();
  }

  async finalizeVotes() {
    if (!this.pollMessage || this.closed) return;
    const startedAt = Date.now();
    const gameId = GameInstance.getInstance().getLifecycleToken();
    this.closed = true; // Claim before awaiting Discord, including concurrent manual closures.
    Scheduler.cancel("minerushVote");

    await this.pollMessage.poll?.end().catch((error) => {
      console.error("Unable to end minerush poll on Discord:", error);
    });

    const answers = this.pollMessage.poll?.answers;
    if (!answers || answers.size === 0) {
      console.info(`event=vote.minerush.finalize game=${gameId} outcome=skipped reason=no_answers`);
      return;
    }

    const answersArray = Array.from(answers.entries());
    const winningEntry = answersArray.reduce(
      (prev, current) =>
        current[1].voteCount > prev[1].voteCount ? current : prev,
      answersArray[0]
    );

    const answer = winningEntry[1]?.text === "Yes";

    this.emit("pollEnd", answer);
    console.info(`event=vote.minerush.finalize game=${gameId} outcome=succeeded result=${answer} duration_ms=${Date.now() - startedAt}`);
  }

  async startMinerushVote() {
    if (this.closed || this.starting || this.pollMessage) return;
    const gameStartTime = GameInstance.getInstance().startTime;
    if (!gameStartTime) {
      console.error("Game start time is not set.");
      return;
    }
    const deadline = new Date(gameStartTime.getTime() - 5 * 60 * 1000);
    if (deadline.getTime() <= Date.now() + 1000) {
      console.warn("Minerush vote window has expired or is too short; poll not opened.");
      return;
    }

    const channel = Channels.announcements;

    if (!channel || !channel.isSendable()) {
      console.error(`Missing send permissions in channel ${channel}`);
      return;
    }

    this.starting = true;
    try {
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
      if (this.closed) {
        await this.pollMessage.delete().catch((error) => console.error("Failed to remove cancelled minerush poll:", error));
        this.pollMessage = undefined;
        return;
      }
      if (deadline.getTime() <= Date.now() + 1000) {
        await this.finalizeVotes();
      } else {
        Scheduler.schedule("minerushVote", async () => {
          await this.finalizeVotes();
        }, deadline);
      }
    } finally {
      this.starting = false;
    }
  }

  async cancelVote() {
    this.closed = true;
    Scheduler.cancel("minerushVote");
    if (this.pollMessage) {
      await this.pollMessage.delete().catch(() => {});
      this.pollMessage = undefined;
    }
    console.info("Minerush vote scheduler has been canceled.");
  }

  async stopVote() {
    if (this.closed) return;
    this.closed = true;
    Scheduler.cancel("minerushVote");
    if (this.pollMessage) {
      console.info("Minerush voting has been ended.");
      await this.pollMessage.poll?.end().catch((error) =>
        console.error("Unable to stop minerush poll on Discord:", error)
      );
    }
  }
}
