import { MatchCleanupState } from "@prisma/client";
import type { Guild } from "discord.js";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { GameInstance } from "../../src/database/GameInstance";
import { prismaClient } from "../../src/database/prismaClient";
import { ConfigManager } from "../../src/ConfigManager";
import { autoReadsForAsk } from "../../src/ai/AiAutoReads";
import { answerAiQuestion } from "../../src/ai/AiAssistant";
import { getGameOrganiserRoster } from "../../src/ai/GameOrganiserReads";
import { getGameDiscordDiagnostics } from "../../src/ai/GameDiscordRead";
import { getGamePersistenceDiagnostics } from "../../src/ai/GamePersistenceRead";
import {
  AiCaller,
  AiToolDenied,
  executeAiTool,
  permittedAiTools,
} from "../../src/ai/AiTools";
import {
  buildApprovedKnowledge,
  retrieveApprovedKnowledge,
} from "../../src/ai/Knowledge";

const member = (ign: string, id: string, captain = false) =>
  ({ latestIGN: ign, ignUsed: ign, discordSnowflake: id, captain }) as any;

const organiser: AiCaller = {
  guildId: "test-guild",
  discordUserId: "test-organiser",
  verifyMembership: async () => ({ member: true, organiser: true }),
};

test("Navi chooses bounded and targeted game observations for realistic organiser requests", () => {
  const cases: Array<[string, string[]]> = [
    [
      "What's left to do before we start?",
      ["get_current_game_state", "get_game_roster"],
    ],
    [
      "Are the teams actually ready?",
      ["get_current_game_state", "get_game_roster"],
    ],
    [
      "Why can't I start this game?",
      ["get_current_game_state", "get_game_roster"],
    ],
    [
      "The RED captain hasn't picked anyone for ages",
      ["get_current_game_state", "get_game_roster"],
    ],
    [
      "One player didn't get moved into the team VC",
      ["get_current_game_state", "get_game_discord_state"],
    ],
    [
      "A player left after we drafted the teams",
      ["get_current_game_state", "get_game_roster"],
    ],
    [
      "The map poll never appeared",
      ["get_current_game_state", "get_game_discord_state"],
    ],
    [
      "Our announcement message never published",
      ["get_current_game_state", "get_game_discord_state"],
    ],
    [
      "I pressed Start and it errored, is it safe to retry?",
      ["get_current_game_state", "get_game_discord_state"],
    ],
    [
      "Shutdown timed out. Has the result already been saved?",
      ["get_current_game_state", "get_game_persistence"],
    ],
    [
      "Database persistence succeeds but Discord cleanup fails",
      ["get_current_game_state", "get_game_persistence"],
    ],
    ["The game finished but I can't end it", ["get_current_game_state"]],
    ["What do we do next?", ["get_current_game_state"]],
  ];
  for (const [question, expected] of cases) {
    const reads = autoReadsForAsk(question, true);
    for (const name of expected)
      assert(
        reads.some((item) => item.name === name),
        question + " must auto-read " + name
      );
    assert(reads.length <= 3, "No unbounded per-question diagnostics");
    assert(
      !reads.some(
        (item) =>
          item.name === "get_game_discord_state" &&
          !["players", "polls", "announcement"].includes(
            JSON.parse(item.arguments).focus
          )
      ),
      "Discord scope is always one bounded known focus"
    );
  }
  assert(
    autoReadsForAsk("How does /game shutdown work?", true).length === 0 &&
      autoReadsForAsk("How do I play?", true).length === 0 &&
      autoReadsForAsk("Meow", true).length === 0,
    "Timeless help and banter do not trigger a live audit"
  );
  assert(
    !autoReadsForAsk("Shutdown timed out; is the result saved?", false).some(
      (r) => r.name === "get_game_persistence"
    ),
    "Player cannot trigger a privileged persistence prefetch"
  );
});

test("Navi captures named rosters, captain bans, paused draft and winner without raw IDs", () => {
  const game = GameInstance.getInstance();
  try {
    game.reset();
    game.announced = true;
    game.teams.RED = [
      member("RedCaptain", "secret-red", true),
      member("RedSecond", "secret-red-2"),
    ];
    game.teams.BLUE = [member("BlueCaptain", "secret-blue", true)];
    game.teams.UNDECIDED = [member("Waiting", "secret-waiting")];
    game.teamsDecidedBy = "DRAFT";
    game.classBanMode = "shared";
    game.settings.sharedCaptainBannedClasses = ["ACROBAT" as any];
    game.recoveryDraftProgress = {
      mode: "draft",
      turn: "RED",
      finishedPicking: false,
      proposedTeams: {
        RED: ["secret-red"],
        BLUE: ["secret-blue"],
        UNDECIDED: ["secret-waiting"],
      },
      lateSignups: [],
    };
    game.isFinished = true;
    game.gameWinner = "RED";
    const state = getGameOrganiserRoster() as any;
    assert(
      state.rosters.RED.players[0].latestIGN === "RedCaptain" &&
        state.rosters.BLUE.players[0].captain &&
        state.rosters.UNDECIDED.total === 1 &&
        state.classBans.shared.includes("ACROBAT"),
      "Recorded rosters, bans and captains reported"
    );
    assert(
      state.draft?.source.includes("paused recovery") &&
        state.draft.turn === "RED" &&
        state.result.winnerInMemory === "RED",
      "Paused draft and winner distinctly reported as memory only"
    );
    const text = JSON.stringify(state);
    assert(
      !text.includes("secret-") &&
        !text.includes("playerId") &&
        text.length < 4000,
      "No raw Discord IDs, player IDs or oversized evidence"
    );
  } finally {
    game.reset();
  }
});

test("Targeted Discord checks distinguish fresh roles from cached voice, and never enumerate the guild", async () => {
  const game = GameInstance.getInstance();
  const config = ConfigManager.getConfig();
  let fetches = 0;
  let messages = 0;
  try {
    game.reset();
    game.announced = true;
    game.teams.RED = [member("RedOne", "discord-red")];
    game.teams.BLUE = [member("BlueOne", "discord-blue")];
    game.announcementMessage = {
      id: "known-message",
      channelId: config.channels.announcements,
    } as any;
    game.mapVoteManager = {
      pollMessage: {
        id: "known-map",
        channelId: config.channels.announcements,
      },
    } as any;
    const guild = {
      members: {
        fetch: async (options: any) => {
          assert(
            typeof options.user === "string" &&
              options.force &&
              options.cache === false,
            "Fresh per-member read only"
          );
          fetches++;
          return {
            roles: {
              cache: new Set(
                options.user === "discord-red"
                  ? [config.roles.redTeamRole]
                  : [config.roles.redTeamRole]
              ),
            },
          };
        },
      },
      voiceStates: {
        cache: new Map([
          ["discord-red", { channelId: config.channels.redTeamVC }],
          ["discord-blue", { channelId: config.channels.teamPickingVC }],
        ]),
      },
      channels: {
        fetch: async (id: string) => {
          assert(
            id === config.channels.announcements,
            "Only configured announcement channel can be queried"
          );
          return {
            messages: {
              fetch: async (options: { message: string; force: boolean }) => {
                assert(
                  options.force &&
                    ["known-message", "known-map"].includes(options.message),
                  "Only server-bound message IDs, forced REST rather than cache"
                );
                messages++;
                return {
                  poll:
                    options.message === "known-map"
                      ? { expiresAt: new Date("2026-12-01T20:00:00Z") }
                      : null,
                };
              },
            },
          };
        },
      },
    } as unknown as Guild;
    const players = (await getGameDiscordDiagnostics(guild, "players")) as any;
    assert(
      fetches === 2 &&
        players.checked === 2 &&
        players.players[0].expectedTeamRole === "present" &&
        players.players[0].voiceGatewayCache.includes("expected VC") &&
        players.players[1].expectedTeamRole === "missing" &&
        players.players[1].oppositeTeamRole.includes("mismatch") &&
        players.players[1].voiceGatewayCache.includes("different VC"),
      "Discord role mismatch and voice cache evidence distinguished"
    );
    const missing = (await getGameDiscordDiagnostics(
      guild,
      "players",
      "NotOnRoster"
    )) as any;
    assert(
      missing.status === "not_found_in_current_roster" && fetches === 2,
      "Cannot scan an arbitrary targetIGN"
    );
    const poll = (await getGameDiscordDiagnostics(guild, "polls")) as any;
    assert(
      poll.checks[0].delivery.includes("exists") &&
        poll.checks[0].poll.includes("unverified") &&
        poll.checks[1].delivery.includes("unverified"),
      "Poll existence is not evidence of closure; missing reference unknown"
    );
    const announced = (await getGameDiscordDiagnostics(
      guild,
      "announcement"
    )) as any;
    assert(
      announced.checks[0].delivery.includes("exists") && messages === 2,
      "Published announcement independently fetched"
    );
    assert(
      !JSON.stringify(players).includes("discord-red"),
      "No Discord snowflakes disclosed"
    );
  } finally {
    game.reset();
  }
});

test("Exact match persistence distinguishes saved/PENDING, COMPLETE, missing and uncertain without writes", async () => {
  const game = GameInstance.getInstance();
  const original = prismaClient.game.findUnique;
  let reads = 0;
  try {
    game.reset();
    (prismaClient.game as any).findUnique = async () => {
      reads++;
      throw new Error("Must not query without a match ID");
    };
    assert(
      ((await getGamePersistenceDiagnostics()) as any).status ===
        "unverified" && reads === 0,
      "No match identity means unknown"
    );

    game.announced = true;
    game.gameId = "exact-match";
    (prismaClient.game as any).findUnique = async (args: any) => {
      reads++;
      assert(
        args.where.id === "exact-match" &&
          args.select.finished === true &&
          args.select.cleanupState === true &&
          !("include" in args),
        "Single typed projection by server-bound match identity"
      );
      return {
        finished: true,
        persistenceFingerprint: "digest",
        cleanupState: MatchCleanupState.PENDING,
        cleanupCompletedAt: null,
      };
    };
    const pending = (await getGamePersistenceDiagnostics()) as any;
    assert(
      pending.savedResult && pending.cleanupCheckpoint === "PENDING",
      "Saved game but incomplete cleanup"
    );
    assert(
      !JSON.stringify(pending).includes("exact-match"),
      "Internal match identity withheld"
    );
    (prismaClient.game as any).findUnique = async () => ({
      finished: true,
      persistenceFingerprint: "digest",
      cleanupState: MatchCleanupState.COMPLETE,
      cleanupCompletedAt: new Date("2026-11-20T21:00:00Z"),
    });
    const complete = (await getGamePersistenceDiagnostics()) as any;
    assert(
      complete.cleanupCheckpoint === "COMPLETE" &&
        complete.warning.includes("not proof"),
      "Checkpoint is not full external audit"
    );
    (prismaClient.game as any).findUnique = async () => null;
    const absent = (await getGamePersistenceDiagnostics()) as any;
    assert(
      absent.status === "not_found" && absent.warning.includes("Never blindly"),
      "Absent record not proof retry safe"
    );
    (prismaClient.game as any).findUnique = async () => {
      throw new Error("secret DB details");
    };
    const unknown = (await getGamePersistenceDiagnostics()) as any;
    assert(
      unknown.status === "unavailable" &&
        !JSON.stringify(unknown).includes("secret"),
      "DB errors are redacted"
    );
  } finally {
    prismaClient.game.findUnique = original;
    game.reset();
  }
});

test("Organiser-only tool ACL denies model filters, invented members and role revocations", async () => {
  const restricted: AiCaller = {
    ...organiser,
    verifyMembership: async () => ({ member: true, organiser: false }),
    inspectGameDiscord: async () => {
      assert(false, "Unauthorised Discord read");
      return null;
    },
  };
  for (const name of [
    "get_game_roster",
    "get_game_discord_state",
    "get_game_persistence",
  ]) {
    assert(
      !permittedAiTools(false).some((t) => t.function.name === name),
      "Private tool hidden from players"
    );
    try {
      await executeAiTool(
        name,
        name === "get_game_discord_state" ? '{"focus":"players"}' : "{}",
        restricted
      );
      assert(false, "Must deny unauthorised tool");
    } catch (e) {
      assert(e instanceof AiToolDenied, "Fresh organiser role required");
    }
  }
  for (const args of [
    '{"focus":"players","targetIGN":"???bad"}',
    '{"focus":"polls","targetIGN":"RedOne"}',
    '{"focus":"players","guildId":"elsewhere"}',
  ]) {
    try {
      await executeAiTool("get_game_discord_state", args, organiser);
      assert(false, "Malformed or escalating filter allowed");
    } catch (e) {
      assert(e instanceof AiToolDenied, "Invalid filters denied");
    }
  }
  const original = prismaClient.player.findUnique;
  let checks = 0;
  try {
    (prismaClient.player as any).findUnique = async () => null;
    const reply = await answerAiQuestion({
      organiser: true,
      caller: {
        ...organiser,
        verifyMembership: async () => ({
          member: true,
          organiser: ++checks < 3,
        }),
      },
      question: "Why can't I start the game?",
      knowledge: [],
      infer: async () => {
        assert(false, "Revoked role must block model delivery");
        return { content: "Never", calls: [] };
      },
    });
    assert(
      reply.text.includes("permissions") && !reply.text.includes("Never"),
      "No sensitive answer after role revocation"
    );
  } finally {
    prismaClient.player.findUnique = original;
  }
});

test("Organiser prefetch provides actual scoped evidence to the provider before it chooses tools", async () => {
  const game = GameInstance.getInstance();
  const previousPlayer = prismaClient.player.findUnique;
  const previousGame = prismaClient.game.findUnique;
  let discordFocus = "";
  try {
    game.reset();
    game.announced = true;
    game.gameId = "internal-match";
    game.teams.RED = [member("RedOne", "hidden-red", true)];
    game.teams.BLUE = [member("BlueOne", "hidden-blue", true)];
    game.teamsDecidedBy = "RANDOMISED";
    (prismaClient.player as any).findUnique = async () => null;
    (prismaClient.game as any).findUnique = async () => ({
      finished: true,
      cleanupState: MatchCleanupState.PENDING,
      cleanupCompletedAt: null,
      persistenceFingerprint: "digest",
    });
    const gameQuestion = await answerAiQuestion({
      question: "One player didn't get moved into the team VC",
      organiser: true,
      caller: {
        ...organiser,
        inspectGameDiscord: async (focus) => {
          discordFocus = focus;
          return {
            status: "ok",
            source: "Discord REST and gateway cache",
            players: [
              {
                ign: "RedOne",
                expectedTeamRole: "present",
                voiceGatewayCache: "in different VC (gateway cache)",
              },
            ],
          };
        },
      },
      knowledge: [],
      infer: async (messages) => {
        const content = messages[2].content ?? "";
        assert(
          content.includes("get_current_game_state:") &&
            content.includes("get_game_discord_state:") &&
            content.includes("RedOne") &&
            content.includes("different VC") &&
            !content.includes("hidden-red"),
          "Prefetch delivered independent process and Discord evidence, without private IDs"
        );
        return {
          content:
            "The current RED roster includes RedOne. Their voice state shows a different VC (gateway cache), not an independently confirmed failed move. Verify in Discord and move them manually if authorised.",
          calls: [],
        };
      },
    });
    assert(
      discordFocus === "players" &&
        gameQuestion.toolNames.includes("get_game_discord_state"),
      "Model did not have to request an additional tool call"
    );
    const shutdown = await answerAiQuestion({
      question: "Shutdown timed out. Has the result already been saved?",
      organiser: true,
      caller: organiser,
      knowledge: [],
      infer: async (messages) => {
        const input = messages[2].content ?? "";
        assert(
          input.includes("get_game_persistence:") &&
            input.includes('"savedResult":true') &&
            input.includes('"cleanupCheckpoint":"PENDING"') &&
            !input.includes("internal-match"),
          "Exact persisted state carried separately from in-memory flags"
        );
        return {
          content:
            "The result is saved, but cleanup is PENDING. Do not rerun /game shutdown; an operator needs to reconcile Discord cleanup.",
          calls: [],
        };
      },
    });
    assert(
      shutdown.toolNames.includes("get_game_persistence") &&
        shutdown.text.includes("Do not"),
      "Shutdown advice grounded in actual checkpoint"
    );
  } finally {
    game.reset();
    prismaClient.player.findUnique = previousPlayer;
    prismaClient.game.findUnique = previousGame;
  }
});

test("Realistic organiser problem phrasing retrieves approved safe recovery guidance", () => {
  const chunks = buildApprovedKnowledge(process.cwd());
  for (const [question, heading] of [
    [
      "The RED captain has stopped picking in the draft",
      "Draft stuck or captain stops picking",
    ],
    ["Map poll never appears", "Map poll never appears or does not finish"],
    [
      "Shutdown timed out and the match may already have been saved",
      "Match result may already have been saved",
    ],
    ["My match /game end failed", "/game end fails or appears to do nothing"],
    [
      "Some players moved to voice but others did not",
      "Some players moved to voice but others did not",
    ],
  ]) {
    const result = retrieveApprovedKnowledge(chunks, question, true);
    assert(
      result.some((c) => c.heading === heading),
      "Missing scenario guidance: " + question
    );
  }
  const shutdown = chunks.find(
    (c) => c.heading === "/game shutdown fails partway through"
  );
  assert(
    shutdown?.content.includes("do not") ||
      shutdown?.content.includes("Do not"),
    "Shutdown scenario must prohibit blind retries"
  );
});
