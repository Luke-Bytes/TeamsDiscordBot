import { AnniMap } from "@prisma/client";
import { Channels } from "../Channels";
import {
  EmbedBuilder,
  Message,
  Snowflake,
  User,
  Collection as DjsCollection,
  PollAnswer,
} from "discord.js";
import EventEmitter from "events";
import { prettifyName, stripVariationSelector } from "../util/Utils";
import { Scheduler } from "../util/SchedulerUtil";
import { GameInstance } from "../database/GameInstance";

const mapToEmojis: Record<AnniMap, string> = {
  AFTERMATH1V1: "🌸",
  ANDORRA1V1: "🏟️",
  ARID1V1: "🏗️",
  CANYON1V1: "🏜️",
  CHASM1V1: "🏝️",
  CHEROKEE1V1: "🪐",
  DREDGE1V1: "🧙",
  DUELSTAL: "™",
  CLASHSTAL: "🪵",
  NATURE1V1: "🌲",
  SIEGE1V1: "♟️",
  HAANSKAAR1V1: "🌋",
  VILLAGES1V1: "🕍",
  ANCHORAGE1V1: "⚓",
  GRASSLANDS1V1: "🍀",
  OUTPOST1V1: "🏕️",
  SKYPIRATES1V1: "🏴‍☠️",
  FOXBERRY1V1: "🫐",
  CASTAWAY1V1: "🌴",
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

  private async countAnswerVoters(
    answer: PollAnswer,
    registeredIds: Set<string>
  ): Promise<{ total: number; valid: number }> {
    let total = 0,
      valid = 0;
    let after: Snowflake | undefined = undefined;
    for (;;) {
      const page: DjsCollection<Snowflake, User> | null = await answer
        .fetchVoters({ limit: 100, after })
        .catch(() => null);
      if (!page) break;
      for (const [id] of page) {
        total++;
        if (registeredIds.has(id)) valid++;
      }
      if (page.size < 100) break;
      after = page.lastKey();
    }
    if (total === 0) {
      const once: DjsCollection<Snowflake, User> | null = await answer
        .fetchVoters()
        .catch(() => null);
      if (once) {
        for (const [id] of once) {
          total++;
          if (registeredIds.has(id)) valid++;
        }
      }
    }
    return { total, valid };
  }

  private pickMapEnum(text: string, emojiName?: string) {
    return Object.entries(mapToEmojis).find(
      ([mapName, emoji]) =>
        mapName === text.toUpperCase().replace(/\s+/g, "") &&
        stripVariationSelector(emoji) ===
          stripVariationSelector(emojiName ?? "")
    )?.[0];
  }

  async finalizeVotes() {
    if (!this.pollMessage) return;

    const current = this.pollMessage!;
    const freshMsg: Message = await current.fetch(true).catch(() => current);
    this.pollMessage = freshMsg;

    const poll = freshMsg.poll;
    if (!poll?.answers || poll.answers.size === 0) {
      console.log("No answers found.");
      return;
    }

    const gi = GameInstance.getInstance();
    const registeredIds = new Set<string>([
      ...gi.teams.RED.map((p) => p.discordSnowflake),
      ...gi.teams.BLUE.map((p) => p.discordSnowflake),
      ...gi.teams.UNDECIDED.map((p) => p.discordSnowflake),
    ]);

    const answersArray = Array.from(poll.answers.entries());
    let counted = await Promise.all(
      answersArray.map(async ([key, answer]) => {
        const text = answer?.text ?? "N/A";
        const emojiName = answer?.emoji?.name ?? "";
        let total = 0,
          valid = 0;
        try {
          const res = await this.countAnswerVoters(answer, registeredIds);
          total = res.total;
          valid = res.valid;
        } catch (e) {
          console.warn("[MapVoteManager] Unable to count answers " + e);
        }
        return {
          key,
          text,
          emojiName,
          count: valid,
          raw: total > 0 ? total : (answer.voteCount ?? 0),
          mapEnum: this.pickMapEnum(text, emojiName),
        };
      })
    );

    const allZero = counted.every((c) => c.raw === 0 && c.count === 0);
    if (allZero) {
      await freshMsg.poll?.end().catch(() => {});
      const refetched: Message = await freshMsg
        .fetch(true)
        .catch(() => freshMsg);
      const poll2 = refetched.poll;
      if (poll2?.answers?.size) {
        const arr2 = Array.from(poll2.answers.entries());
        counted = await Promise.all(
          arr2.map(async ([key, answer]) => {
            const text = answer?.text ?? "N/A";
            const emojiName = answer?.emoji?.name ?? "";
            let total = 0,
              valid = 0;
            try {
              const res = await this.countAnswerVoters(answer, registeredIds);
              total = res.total;
              valid = res.valid;
            } catch (e) {
              console.warn("[MapVoteManager] Unable to retrieve answers " + e);
            }
            return {
              key,
              text,
              emojiName,
              count: valid,
              raw: total > 0 ? total : (answer.voteCount ?? 0),
              mapEnum: this.pickMapEnum(text, emojiName),
            };
          })
        );
        this.pollMessage = refetched;
      }
    }

    console.log(
      JSON.stringify(
        counted.map((c) => ({
          Key: c.key,
          Text: c.text,
          CountedVotes: c.count,
          RawVoteCount: c.raw,
        })),
        null,
        2
      )
    );

    /* LEGACY BLOCK START (unreachable after tidy results return) */
    const officialMax = Math.max(...counted.map((c) => c.count));
    const officialTop = counted.filter((c) => c.count === officialMax);
    const discordMax = Math.max(...counted.map((c) => c.raw));
    const discordTop = counted.filter((c) => c.raw === discordMax);

    const diffOrDraw =
      officialTop.length !== 1 ||
      discordTop.length !== 1 ||
      (officialTop[0] &&
        discordTop[0] &&
        officialTop[0].key !== discordTop[0].key);

    if (diffOrDraw) {
      const lines = counted
        .slice()
        .sort((a, b) => b.count - a.count || b.raw - a.raw)
        .map(
          (c) =>
            `• ${c.text}: **${c.count}** registered / ${c.raw} total (${Math.max(0, c.raw - c.count)} discounted)`
        );
      const officialStr = officialTop.map((c) => c.text).join(", ") || "—";

      const embed = new EmbedBuilder()
        .setTitle("Map Vote Result")
        .setDescription(
          "The result was affected disproportionally by unregistered votes, only votes from **registered players** are counted."
        )
        .addFields(
          {
            name: `Official winner${officialTop.length > 1 ? "s" : ""}`,
            value: officialStr,
            inline: false,
          },
          { name: "Breakdown", value: lines.join("\n"), inline: false }
        );

      await this.pollMessage!.reply({ embeds: [embed] }).catch(() => {});
    } else {
      await this.pollMessage.poll?.end().catch(() => {});
    }
    /* LEGACY BLOCK END */

    if (officialTop.length === 1 && officialTop[0].mapEnum) {
      this.emit("pollEnd", officialTop[0].mapEnum as AnniMap);
    } else {
      console.error(
        "No single official winner could be determined. Manual tiebreaker required."
      );
    }
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
          emoji: stripVariationSelector(mapToEmojis[v]),
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
    Scheduler.cancel("mapVote");
    if (this.pollMessage) {
      await this.pollMessage.delete().catch(() => {});
      this.pollMessage = undefined;
    }
    console.info("Map vote scheduler has been canceled.");
  }

  async stopVote() {
    Scheduler.cancel("mapVote");
    if (this.pollMessage) {
      console.info("Minerushing voting has been ended.");
      this.pollMessage.poll?.end();
    }
  }
}
