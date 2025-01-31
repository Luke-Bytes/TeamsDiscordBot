import { AnniMap } from "@prisma/client";
import { Channels } from "../Channels";
import { Message } from "discord.js";
import EventEmitter from "events";
import { prettifyName } from "../util/Utils";
import { Scheduler } from "../util/SchedulerUtil";
import { GameInstance } from "../database/GameInstance";

//todo: store these three maps somewhere else?
const mapToEmojis: Record<AnniMap, string> = {
  AFTERMATH1V1: "🌸 ",
  ANDORRA1V1: "🏟️ ",
  ARID1V1: "🏗️ ",
  CANYON1V1: "🏜️ ",
  CHASM1V1: "🏝️ ",
  CHEROKEE1V1: "🪐 ",
  DREDGE1V1: "🧙 ",
  DUELSTAL: "™️ ",
  CLASHSTAL: "🪵 ",
  NATURE1V1: "🌲 ",
  SIEGE1V1: "♟️ ",
  HAANSKAAR1V1: "🌋 ",
  VILLAGES1V1: "🕍 ",
  ANCHORAGE1V1: "⚓ ",
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

    if (
      !this.pollMessage.poll?.answers ||
      this.pollMessage.poll.answers.size === 0
    ) {
      console.log("No answers found.");
      return;
    }

    const answersArray = Array.from(this.pollMessage.poll.answers.entries());

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

    const winningText = (winningEntry[1].text ?? "")
      .toUpperCase()
      .replace(/\s+/g, "");
    const winningMap = Object.entries(mapToEmojis).find(
      ([mapName]) => mapName === winningText
    )?.[0];

    console.log(
      JSON.stringify(
        {
          WinningMap: winningMap ?? "None found",
          VoteCount: winningEntry[1].voteCount,
        },
        null,
        2
      )
    );

    if (!winningMap) {
      console.error("Could not find winning map!");
      return;
    }

    this.emit("pollEnd", winningMap as AnniMap);
  }

  async startMapVote() {
    const channel = Channels.announcements;

    if (!channel || !channel.isSendable()) {
      console.error(`Missing send permissions in channel ${channel}`);
      return;
    }

    this.pollMessage = await channel.send({
      poll: {
        question: { text: "Map vote" },
        answers: this.maps.map((v) => ({
          text: prettifyName(v),
          emoji: mapToEmojis[v],
        })),
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
        `Scheduling map poll closure in ${delay / 1000}s at ${fiveMinutesBeforeStart.toISOString()}`
      );

      Scheduler.schedule(
        "mapVote",
        async () => {
          console.info(`Finalizing map vote at ${new Date().toISOString()}`);
          await this.finalizeVotes();
        },
        fiveMinutesBeforeStart
      );
    } else {
      console.warn("Game start time already passed or is within 5 minutes.");
    }
  }

  async cancelVote() {
    if (this.pollMessage) {
      Scheduler.cancel("mapVote");
      await this.pollMessage.delete();
      this.pollMessage = undefined;

      console.info("Map vote and its scheduler have been canceled.");
    } else {
      console.warn("No poll message to delete or cancel.");
    }
  }
}
