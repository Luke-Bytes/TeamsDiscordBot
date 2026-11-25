import { SeasonType } from "@prisma/client";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { prismaClient } from "../../src/database/prismaClient";
import { SeasonService } from "../../src/database/SeasonService";
import { answerAiQuestion } from "../../src/ai/AiAssistant";
import { autoReadsForAsk } from "../../src/ai/AiAutoReads";
import { resolveAiPlayerReferences } from "../../src/ai/AiPlayerReferences";
import { getLinkedIgnForGuildMention } from "../../src/ai/AiRequestService";

const SELF = "111111111111111111";
const STEVE = "222222222222222222";
const OTHER = "333333333333333333";
const THIRD = "444444444444444444";

test("Navi resolves real member mentions and 'me' into comparable player IGNs", async () => {
  let lookedUp = 0;
  const lookup = async (id: string) => {
    assert(id === STEVE, "Mention ID is looked up, not accepted as an IGN");
    lookedUp++;
    return { status: "linked" as const, ign: "Backmobe" };
  };
  for (const question of [
    `compare me and <@${STEVE}>`,
    `compare me with <@!${STEVE}>`,
    `who has more MVPs, <@${STEVE}> or me?`,
  ]) {
    const result = await resolveAiPlayerReferences(
      question,
      SELF,
      { status: "linked", ign: "Ungenes" },
      lookup
    );
    assert(
      !result.error &&
        !result.question.includes(STEVE) &&
        result.question.includes("Ungenes") &&
        result.question.includes("Backmobe"),
      "Only validated IGN text reaches the model"
    );
    const reads = autoReadsForAsk(result.question);
    assert(
      reads.length === 4 &&
        reads.filter((r) => r.name === "get_player_all_time_stats").length ===
          2 &&
        reads.filter((r) => r.name === "get_player_stats").length === 2,
      "Comparison triggers both players' career and active-season stats"
    );
  }
  assert(
    lookedUp === 3,
    "One targeted lookup per question, not a whole guild search"
  );
});

test("Repeated mentions are deduplicated; too many and unresolved mentions fail safely", async () => {
  let checks = 0;
  const repeated = await resolveAiPlayerReferences(
    `Compare <@${STEVE}> and <@!${STEVE}> for stats`,
    SELF,
    { status: "linked", ign: "Ungenes" },
    async () => {
      checks++;
      return { status: "linked", ign: "Backmobe" };
    }
  );
  assert(
    checks === 1 && !repeated.question.includes(STEVE),
    "Duplicate tags do not cause duplicate membership/database lookups"
  );

  const tooMany = await resolveAiPlayerReferences(
    `compare <@${STEVE}>, <@${OTHER}> and <@${THIRD}>`,
    SELF,
    { status: "linked", ign: "Ungenes" },
    async () => {
      assert(false, "Over-limit mentions are rejected before any DB calls");
      return { status: "unavailable" };
    }
  );
  assert(
    !!tooMany.error && tooMany.error.includes("two mentioned players"),
    "Mention lookup count is explicitly bounded"
  );

  for (const status of ["unlinked", "unavailable"] as const) {
    const result = await resolveAiPlayerReferences(
      `compare me and <@${STEVE}>`,
      SELF,
      { status: "linked", ign: "Ungenes" },
      async () => ({ status })
    );
    assert(
      !!result.error &&
        !result.error.includes(STEVE) &&
        (status === "unlinked"
          ? result.error.includes("no valid linked")
          : result.error.includes("couldn't verify")),
      "Unlinked players and failed lookups do not turn into false stats"
    );
  }
  const noSelf = await resolveAiPlayerReferences(
    `compare me and <@${STEVE}>`,
    SELF,
    { status: "unlinked" },
    async () => ({ status: "linked", ign: "Backmobe" })
  );
  assert(
    !!noSelf.error && noSelf.error.includes("your linked"),
    "An unlinked caller is not guessed from their Discord name"
  );
});

test("Casual mentions need no player lookup; plain @names are not trusted identities", async () => {
  const casual = await resolveAiPlayerReferences(
    `say hello to <@${STEVE}>`,
    SELF,
    { status: "linked", ign: "Ungenes" },
    async () => {
      assert(false, "No DB reads for casual mentions");
      return { status: "linked", ign: "Backmobe" };
    }
  );
  assert(
    !casual.question.includes(STEVE) &&
      casual.question.includes("a mentioned member") &&
      !casual.error,
    "Raw snowflakes are removed even when no player lookup is needed"
  );

  const plainName = await resolveAiPlayerReferences(
    "compare me and @steve",
    SELF,
    { status: "linked", ign: "Ungenes" }
  );
  assert(
    plainName.error?.includes("Discord's @mention suggestions"),
    "A hand-typed alias must be selected as an actual Discord mention"
  );

  const selfMention = await resolveAiPlayerReferences(
    `compare <@${SELF}> and <@${STEVE}>`,
    SELF,
    { status: "linked", ign: "Ungenes" },
    async (id) => {
      assert(id === STEVE, "Own mention reuses the already verified identity");
      return { status: "linked", ign: "Backmobe" };
    }
  );
  assert(
    selfMention.question.includes("Ungenes") &&
      selfMention.question.includes("Backmobe"),
    "Self mentions use caller identity without another Discord read"
  );
});

test("Discord-to-IGN adapter requires a current guild member and real linked account", async () => {
  const oldFind = prismaClient.player.findUnique;
  let fetched = 0;
  let queried = 0;
  let memberAvailable = true;
  let record: any = { latestIGN: "Backmobe" };
  const guild: any = {
    members: {
      fetch: async (args: any) => {
        fetched++;
        assert(
          args.user === STEVE && args.force === true,
          "Mention target must be freshly checked in the home guild"
        );
        if (!memberAvailable)
          throw new Error("Guild member lookup unavailable");
        return { user: { bot: false } };
      },
    },
  };
  try {
    (prismaClient.player as any).findUnique = async (args: any) => {
      queried++;
      assert(
        args.where.discordSnowflake === STEVE &&
          args.select.latestIGN === true &&
          Object.keys(args.select).length === 1,
        "Only the member's linked IGN is read"
      );
      if (record instanceof Error) throw record;
      return record;
    };
    assert(
      (await getLinkedIgnForGuildMention(guild, STEVE)).ign === "Backmobe",
      "Current latest IGN, not a Discord nickname, is used"
    );
    record = null;
    assert(
      (await getLinkedIgnForGuildMention(guild, STEVE)).status === "unlinked",
      "Missing link is not an invented IGN"
    );
    record = new Error("Database offline");
    assert(
      (await getLinkedIgnForGuildMention(guild, STEVE)).status ===
        "unavailable",
      "DB error is not misreported as an unlinked account"
    );
    memberAvailable = false;
    assert(
      (await getLinkedIgnForGuildMention(guild, STEVE)).status ===
        "unavailable",
      "Failed membership check is not trusted"
    );
    const count = queried;
    assert(
      (await getLinkedIgnForGuildMention(guild, "not-an-id")).status ===
        "unavailable" &&
        queried === count &&
        fetched === 4,
      "Invalid IDs never reach Discord or Prisma"
    );
  } finally {
    prismaClient.player.findUnique = oldFind;
  }
});

test("End-to-end mentioned comparison uses both players' actual stats without leaking IDs", async () => {
  const previous = {
    identity: prismaClient.player.findUnique,
    named: prismaClient.player.findMany,
    aggregate: prismaClient.playerStats.aggregate,
    best: prismaClient.playerStats.findFirst,
    recent: prismaClient.playerStats.findMany,
    current: prismaClient.playerStats.findUnique,
    ranks: prismaClient.playerStats.count,
    season: SeasonService.getActiveSeason,
    count: prismaClient.gameParticipation.count,
    last: prismaClient.gameParticipation.findFirst,
  };
  let inferred = 0;
  try {
    (prismaClient.player as any).findUnique = async () => ({
      latestIGN: "Ungenes",
    });
    (prismaClient.player as any).findMany = async (query: any) => [
      {
        id: query.where.latestIGN.equals,
        latestIGN: query.where.latestIGN.equals,
      },
    ];
    (prismaClient.playerStats as any).aggregate = async () => ({
      _count: { _all: 1 },
      _sum: { wins: 6, losses: 4 },
      _max: { biggestWinStreak: 2, biggestLosingStreak: 1 },
    });
    (prismaClient.playerStats as any).findFirst = async () => null;
    (prismaClient.playerStats as any).findMany = async () => [];
    (prismaClient.playerStats as any).findUnique = async () => ({
      wins: 6,
      losses: 4,
      elo: 1100,
      winStreak: 2,
      loseStreak: 0,
    });
    (prismaClient.playerStats as any).count = async () => 0;
    (prismaClient.gameParticipation as any).count = async () => 1;
    (prismaClient.gameParticipation as any).findFirst = async () => null;
    (SeasonService as any).getActiveSeason = async () => ({
      id: "offline-season",
      number: 7,
      type: SeasonType.RANKED,
    });
    const answer = await answerAiQuestion({
      question: `compare me and <@!${STEVE}>`,
      organiser: false,
      knowledge: [],
      caller: {
        discordUserId: SELF,
        guildId: "offline-guild",
        verifyMembership: async () => ({ member: true, organiser: false }),
        resolveMentionedPlayer: async (id) => {
          assert(id === STEVE, "Target is verified by the callback");
          return { status: "linked", ign: "Backmobe" };
        },
      },
      infer: async (messages) => {
        inferred++;
        const text = JSON.stringify(messages);
        assert(
          text.includes("compare Ungenes and Backmobe") &&
            text.includes("get_player_all_time_stats") &&
            text.includes("get_player_stats") &&
            !text.includes(STEVE) &&
            !text.includes(SELF),
          "Prompt and prefetched observations contain linked IGN stats, no Discord IDs"
        );
        return { content: "Both players have comparable stats.", calls: [] };
      },
    });
    assert(
      inferred === 1 &&
        answer.toolNames.length === 4 &&
        answer.toolNames.filter((name) => name === "get_player_stats")
          .length === 2 &&
        answer.toolNames.filter((name) => name === "get_player_all_time_stats")
          .length === 2,
      "One AI inference receives four relevant read-only comparisons"
    );
  } finally {
    prismaClient.player.findUnique = previous.identity;
    prismaClient.player.findMany = previous.named;
    prismaClient.playerStats.aggregate = previous.aggregate;
    prismaClient.playerStats.findFirst = previous.best;
    prismaClient.playerStats.findMany = previous.recent;
    prismaClient.playerStats.findUnique = previous.current;
    prismaClient.playerStats.count = previous.ranks;
    SeasonService.getActiveSeason = previous.season;
    prismaClient.gameParticipation.count = previous.count;
    prismaClient.gameParticipation.findFirst = previous.last;
  }
});
