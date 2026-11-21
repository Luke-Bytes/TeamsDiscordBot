import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { HistoricalStatsClient } from "../../src/ai/HistoricalStatsClient";
import {
  executeAiTool,
  AiToolDenied,
  permittedAiTools,
  AiCaller,
} from "../../src/ai/AiTools";
import { answerAiQuestion } from "../../src/ai/AiAssistant";
import { prismaClient } from "../../src/database/prismaClient";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { MatchRecoveryGate } from "../../src/logic/MatchRecoveryGate";

const env: NodeJS.ProcessEnv = {
  TEAMS_AI_HISTORICAL_ENABLED: "true",
  TEAMS_AI_REST_API_ORIGIN: "http://127.0.0.1:3000",
  TEAMS_AI_REST_API_APPROVED_ORIGIN: "http://127.0.0.1:3000",
};
const user: AiCaller = {
  guildId: "test-guild",
  discordUserId: "authorised-user",
  verifyMembership: async () => ({ member: true, organiser: false }),
};
const player = {
  latestIGN: "ExampleIGN",
  wins: 9,
  losses: 4,
  winStreak: 2,
  loseStreak: 0,
  biggestWinStreak: 5,
  biggestLosingStreak: 2,
  elo: 1234,
  discordSnowflake: "private-discord-id",
  minecraftAccounts: ["private-uuid"],
  primaryMinecraftAccount: "secret",
  seasonId: "internal-season-id",
  id: "raw-id",
};
const elo = [
  { createdAt: "2026-03-03T12:00:00.000Z", elo: 1100, playerId: "secret" },
  { createdAt: "2026-03-01T12:00:00.000Z", elo: 1000, playerId: "secret" },
  { createdAt: "2026-03-02T12:00:00.000Z", elo: 1050, playerId: "secret" },
];
const games = [
  {
    finished: true,
    startTime: "2026-01-01T10:00:00Z",
    endTime: "2026-01-01T11:00:00Z",
    organiser: "private",
    settings: { arbitrary: "secret" },
  },
  {
    finished: false,
    startTime: "2026-01-02T10:00:00Z",
    endTime: "2026-01-02T11:00:00Z",
  },
  {
    finished: true,
    startTime: "2026-01-03T10:00:00Z",
    endTime: "2026-01-03T11:00:00Z",
    gameId: "private",
  },
];
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
type Responder = (
  path: string,
  options: RequestInit
) => Response | Promise<Response>;
function fixture(
  responder?: Responder,
  customEnv: NodeJS.ProcessEnv = env,
  maxRequests = 6
) {
  const calls: {
    path: string;
    method: string | undefined;
    redirect: RequestRedirect | undefined;
  }[] = [];
  const fallback: Responder = (path) => {
    if (path === "/api/seasons")
      return json([
        { number: 8, type: "RANKED", isActive: false, _id: "hidden" },
        { number: 11, type: "RELAXED", isActive: true, _id: "hidden" },
      ]);
    if (path.startsWith("/api/seasons/")) {
      const number = Number(path.split("/").pop());
      return number === 99
        ? json({ message: "Not found" }, 404)
        : json({
            number,
            type: number === 11 ? "RELAXED" : "RANKED",
            isActive: false,
            _id: "hidden",
          });
    }
    if (path.startsWith("/api/player/"))
      return path.includes("MissingIGN")
        ? json({ message: "Not found" }, 404)
        : json(player);
    if (path.startsWith("/api/elohistory/")) return json(elo);
    if (path.startsWith("/api/gameHistory")) return json(games);
    return json({ message: "Forbidden endpoint" }, 500);
  };
  const client = new HistoricalStatsClient({
    env: customEnv,
    maxRequests,
    timeoutMs: 100,
    fetchImpl: (async (url: string, options: RequestInit) => {
      const parsed = new URL(url);
      calls.push({
        path: parsed.pathname + parsed.search,
        method: options.method,
        redirect: options.redirect,
      });
      assert(
        parsed.origin === env.TEAMS_AI_REST_API_ORIGIN,
        "Fixed approved origin"
      );
      assert(
        options.method === "GET" &&
          options.redirect === "error" &&
          !!options.signal,
        "GET only, redirects denied and timeout applied"
      );
      return (responder ?? fallback)(parsed.pathname + parsed.search, options);
    }) as typeof fetch,
  });
  return { client, calls };
}
function validPlayerResponse(path: string) {
  if (path.startsWith("/api/player/")) return json(player);
  if (path.startsWith("/api/seasons/"))
    return json({
      number: Number(path.split("/").pop()),
      type: "RANKED",
      isActive: false,
    });
  return json({});
}

test("Historical REST origin approval is explicit, IP-literal and opt-in; no arbitrary URLs", async () => {
  for (const invalid of [
    { ...env, TEAMS_AI_HISTORICAL_ENABLED: "false" },
    { ...env, TEAMS_AI_REST_API_APPROVED_ORIGIN: "http://127.0.0.1:3001" },
    {
      ...env,
      TEAMS_AI_REST_API_ORIGIN: "http://localhost:3000",
      TEAMS_AI_REST_API_APPROVED_ORIGIN: "http://localhost:3000",
    },
    {
      ...env,
      TEAMS_AI_REST_API_ORIGIN: "http://127.0.0.1:3000/api",
      TEAMS_AI_REST_API_APPROVED_ORIGIN: "http://127.0.0.1:3000/api",
    },
    {
      ...env,
      TEAMS_AI_REST_API_ORIGIN: "http://169.254.169.254",
      TEAMS_AI_REST_API_APPROVED_ORIGIN: "http://169.254.169.254",
    },
    {
      ...env,
      TEAMS_AI_REST_API_ORIGIN: "http://[::ffff:a9fe:a9fe]",
      TEAMS_AI_REST_API_APPROVED_ORIGIN: "http://[::ffff:a9fe:a9fe]",
    },
    {
      ...env,
      TEAMS_AI_REST_API_ORIGIN: "http://evil@example.com",
      TEAMS_AI_REST_API_APPROVED_ORIGIN: "http://evil@example.com",
    },
  ]) {
    const harness = fixture(undefined, invalid);
    const result = await harness.client.listSeasons();
    assert(
      result.status === "unavailable" && harness.calls.length === 0,
      "Invalid configuration never makes HTTP requests"
    );
  }
  assert(
    !permittedAiTools(false, false).some(
      (tool) => tool.function.name === "get_historical_elo"
    ),
    "Disabled HTTP feature hides its schema from the model"
  );
  assert(
    permittedAiTools(false, true).some(
      (tool) => tool.function.name === "get_historical_elo"
    ),
    "Approved HTTP feature advertises fixed public schema"
  );
  const harness = fixture();
  const result: any = await harness.client.playerStats("ExampleIGN", 8);
  assert(
    result.status === "ok",
    "Approved loopback HTTP is supported explicitly"
  );
  assert(harness.calls.length === 2, "Only two fixed GETs");
  assert(
    harness.calls.every((call) => !call.path.includes("custom-query")),
    "Never use arbitrary query API"
  );
});

test("Historical player output is explicit, Ranked/Relaxed-aware, and strips private fields", async () => {
  const { client, calls } = fixture();
  const ranked: any = await client.playerStats("ExampleIGN", 8);
  assert(
    ranked.wins === 9 &&
      ranked.losses === 4 &&
      ranked.elo === 1234 &&
      ranked.type === "RANKED",
    "Valid statistics"
  );
  assert(
    ranked.source === "REST_API historical stats",
    "Verifiable data origin"
  );
  const payload = JSON.stringify(ranked);
  for (const privateValue of [
    "private-discord-id",
    "private-uuid",
    "internal-season-id",
    "raw-id",
    "primaryMinecraftAccount",
  ])
    assert(
      !payload.includes(privateValue),
      "Raw private fields must never be forwarded"
    );
  const relaxed: any = await client.playerStats("ExampleIGN", 11);
  assert(
    relaxed.elo === null && relaxed.type === "RELAXED",
    "Relaxed Elo suppressed"
  );
  assert(
    calls.every((call) => call.method === "GET"),
    "Read only transport"
  );
});

test("Elo points are ordered chronologically; summaries use observed evidence only", async () => {
  const { client, calls } = fixture();
  const result: any = await client.elo("ExampleIGN", 8, 2);
  assert(
    result.status === "ok" &&
      result.startingElo === 1000 &&
      result.latestElo === 1100,
    "Observed chronological boundary Elo"
  );
  assert(
    result.highestObservedElo === 1100 &&
      result.lowestObservedElo === 1000 &&
      result.observedChange === 100,
    "Derived from returned evidence"
  );
  assert(
    result.points.length === 2 &&
      result.points[0].elo === 1050 &&
      result.points[1].elo === 1100,
    "Only most recent bounded points"
  );
  const relaxed: any = await client.elo("ExampleIGN", 11);
  assert(relaxed.status === "unsupported", "No invented Relaxed Elo");
  assert(
    !calls.some(
      (call) =>
        call.path.includes("/api/elohistory/") &&
        call.path.includes("season=11")
    ),
    "Relaxed seasons skip needless Elo API requests"
  );
});

test("Season match totals count finished games only and never expose raw game documents", async () => {
  const { client } = fixture();
  const result: any = await client.seasonSummary(8);
  assert(
    result.status === "ok" &&
      result.completedMatches === 2 &&
      result.inspectedGameRecords === 3,
    "Only finished records counted"
  );
  assert(
    result.observedDateRange.first.startsWith("2026-01-01"),
    "Valid observed date range"
  );
  assert(
    !JSON.stringify(result).includes("private"),
    "No raw game or settings forwarded"
  );
});

test("Historical season listing is bounded, sorted and only publishes approved fields", async () => {
  const { client } = fixture();
  const result: any = await client.listSeasons();
  assert(
    result.status === "ok" && result.seasons.length === 2,
    "Verified season list"
  );
  assert(
    result.seasons[0].number === 8 && result.seasons[1].number === 11,
    "Chronological ordering"
  );
  assert(!JSON.stringify(result).includes("hidden"), "Internal IDs absent");
});

test("404, 429, 500 and missing records provide honest outcomes", async () => {
  const { client } = fixture();
  assert(
    (await client.playerStats("MissingIGN", 8)).status === "not_found",
    "Missing player"
  );
  assert(
    (await client.seasonSummary(99)).status === "not_found",
    "Missing season"
  );
  for (const code of [429, 500]) {
    const harness = fixture(() => json({ message: "Upstream secret" }, code));
    const response: any = await harness.client.listSeasons();
    assert(
      response.status === "unavailable" &&
        !JSON.stringify(response).includes("Upstream secret"),
      "Controlled upstream error"
    );
  }
});

test("Malformed, oversize, excessive Elo and game history fail without partial claims", async () => {
  const malformed = fixture((path) =>
    path.startsWith("/api/player/")
      ? json({ ...player, wins: "nine" })
      : validPlayerResponse(path)
  );
  assert(
    (await malformed.client.playerStats("ExampleIGN", 8)).status ===
      "unavailable",
    "Reject invalid numeric stats"
  );
  const oversized = fixture(() => json({ secret: "x".repeat(140000) }));
  assert(
    (await oversized.client.listSeasons()).status === "unavailable",
    "Response byte cap"
  );
  const gameLimit = fixture((path) =>
    path.startsWith("/api/gameHistory")
      ? json(Array.from({ length: 201 }, () => ({ finished: true })))
      : validPlayerResponse(path)
  );
  assert(
    (await gameLimit.client.seasonSummary(8)).status === "unavailable",
    "Do not mistake truncated match history for complete count"
  );
  const eloLimit = fixture((path) =>
    path.startsWith("/api/elohistory")
      ? json(
          Array.from({ length: 501 }, () => ({
            createdAt: "2026-03-01T00:00:00Z",
            elo: 1000,
          }))
        )
      : validPlayerResponse(path)
  );
  assert(
    (await eloLimit.client.elo("ExampleIGN", 8)).status === "unavailable",
    "Unbounded Elo not forwarded"
  );
  const invalidDate = fixture((path) =>
    path.startsWith("/api/elohistory")
      ? json([{ createdAt: "not-a-date", elo: 1000 }])
      : validPlayerResponse(path)
  );
  assert(
    (await invalidDate.client.elo("ExampleIGN", 8)).status === "unavailable",
    "Reject invalid timestamps"
  );
});

test("Timeouts, failures and redirects never trigger fallback requests", async () => {
  const timeout = fixture(
    (_path, options) =>
      new Promise<Response>((_resolve, reject) => {
        (options.signal as AbortSignal).addEventListener(
          "abort",
          () => reject(new Error("offline timeout")),
          { once: true }
        );
      })
  );
  const timed = await timeout.client.listSeasons();
  assert(
    timed.status === "unavailable" && timeout.calls.length === 1,
    "Timeout aborts without retry"
  );
  const broken = fixture(() =>
    Promise.reject(new Error("network broken with private details"))
  );
  assert(
    (await broken.client.listSeasons()).status === "unavailable" &&
      broken.calls.length === 1,
    "Connection failures sanitized"
  );
  const redirect = fixture(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://malicious.example" },
      })
  );
  assert(
    (await redirect.client.listSeasons()).status === "unavailable" &&
      redirect.calls.length === 1,
    "No redirect follows"
  );
});

test("Historical comparison has fixed four upstream reads and enforces budget", async () => {
  const harness = fixture();
  const result: any = await harness.client.compare("ExampleIGN", 8, 10);
  assert(
    result.status === "ok" &&
      result.winsDifference === 0 &&
      harness.calls.length === 4,
    "Two season-player reads per comparison"
  );
  const exhausted = fixture(undefined, env, 2);
  const unavailable: any = await exhausted.client.compare("ExampleIGN", 8, 10);
  assert(
    unavailable.status === "unavailable" && exhausted.calls.length === 2,
    "Total request budget fails closed"
  );
  const separate = fixture();
  const noSameSeason = await separate.client.compare("ExampleIGN", 8, 8);
  assert(
    noSameSeason.status === "unavailable" && separate.calls.length === 0,
    "Invalid comparison denied before I/O"
  );
});

test("Tool argument validation prevents arbitrary URLs, methods, filters and impersonation", async () => {
  const harness = fixture();
  const invalid: [string, string][] = [
    ["get_historical_player_stats", '{"ign":"bad/name","season":8}'],
    ["get_historical_player_stats", '{"ign":"ExampleIGN","season":"8"}'],
    [
      "get_historical_player_stats",
      '{"ign":"ExampleIGN","season":8,"url":"http://unsafe"}',
    ],
    ["get_historical_elo", '{"ign":"ExampleIGN","season":8,"limit":50}'],
    ["get_my_historical_stats", '{"season":8,"ign":"OtherIGN"}'],
    ["get_my_historical_elo", '{"season":8,"discordUserId":"other"}'],
    ["get_my_historical_comparison", '{"firstSeason":8,"secondSeason":8}'],
    ["get_current_game_state", '{"audience":"organiser"}'],
    ["list_historical_seasons", '{"path":"/api/custom-query"}'],
    ["get_arbitrary_url", '{"url":"http://unsafe"}'],
  ];
  for (const [name, args] of invalid) {
    try {
      await executeAiTool(name, args, user, harness.client);
      assert(false, "Unsafe tool must be rejected");
    } catch (error) {
      assert(error instanceof AiToolDenied, "Rejected server-side");
    }
  }
  assert(
    harness.calls.length === 0,
    "Invalid tool arguments cause no network I/O"
  );
});

test("Self history binds trusted Discord mapping, not prompt-supplied IGN", async () => {
  const original = prismaClient.player.findUnique;
  const harness = fixture();
  let queried: any;
  try {
    (prismaClient.player as any).findUnique = async (query: any) => {
      queried = query;
      return {
        latestIGN: "ExampleIGN",
        discordSnowflake: "should-not-be-sent",
      };
    };
    const result: any = await executeAiTool(
      "get_my_historical_stats",
      '{"season":8}',
      user,
      harness.client
    );
    assert(
      result.status === "ok" && result.player === "ExampleIGN",
      "Trusted Minecraft identity is used"
    );
    assert(
      queried.where.discordSnowflake === user.discordUserId,
      "Discord caller ID not model controlled"
    );
    assert(
      harness.calls.some((call) =>
        call.path.includes("/api/player/ExampleIGN")
      ),
      "Only the linked IGN queried"
    );
    const comparison: any = await executeAiTool(
      "get_my_historical_comparison",
      '{"firstSeason":8,"secondSeason":10}',
      user,
      fixture().client
    );
    assert(comparison.status === "ok", "Self comparison supported");
  } finally {
    prismaClient.player.findUnique = original;
  }
});

test("Unified current game state includes complete snapshot in one tool call, but hides operational fields from players", async () => {
  const game = CurrentGameManager.getCurrentGame();
  const originalBlock = MatchRecoveryGate.getBlockReason;
  try {
    game.reset();
    const inactive: any = await executeAiTool(
      "get_current_game_state",
      "{}",
      user
    );
    assert(
      inactive.lifecycle === "inactive" &&
        inactive.registration.count === 0 &&
        inactive.source === "current bot process snapshot",
      "Valid inactive result"
    );
    game.announced = true;
    game.startTime = new Date("2026-08-03T19:00:00Z");
    game.teams.UNDECIDED = [{ discordSnowflake: "secret-player-id" } as any];
    const announced: any = await executeAiTool(
      "get_current_game_state",
      "{}",
      user
    );
    assert(
      announced.lifecycle === "announced" && announced.registration.count === 1,
      "Announced with public registration totals"
    );
    assert(
      announced.teams.undecided === 1 && announced.teams.stage === "pending",
      "Pending roster"
    );
    const publicPayload = JSON.stringify(announced);
    for (const forbidden of [
      "captains",
      "classBans",
      "recoveryBlocked",
      "timers",
      "polls",
      "readiness",
    ])
      assert(
        !(forbidden in announced),
        "No organiser-only fields in player result"
      );
    assert(
      !publicPayload.includes("secret-player-id"),
      "No player IDs in public result"
    );
    assert(
      !permittedAiTools(false).some(
        (tool) => tool.function.name === "get_game_diagnostics"
      ),
      "Private diagnostic schema remains withheld"
    );
    assert(
      permittedAiTools(false).some(
        (tool) => tool.function.name === "get_current_game_state"
      ),
      "Public snapshot available"
    );

    game.teams.RED = [{ discordSnowflake: "secret-red", captain: true } as any];
    game.teams.BLUE = [
      { discordSnowflake: "secret-blue", captain: true } as any,
    ];
    game.teamsDecidedBy = "DRAFT";
    game.mapVoteManager = { pollMessage: { id: "secret-poll-id" } } as any;
    (MatchRecoveryGate as any).getBlockReason = () => "secret recovery reason";
    const organiser: any = await executeAiTool("get_current_game_state", "{}", {
      ...user,
      verifyMembership: async () => ({ member: true, organiser: true }),
    });
    assert(
      organiser.teams.playable &&
        organiser.captains.redAssigned &&
        organiser.captains.blueAssigned,
      "Final roster, captains in one call"
    );
    assert(
      organiser.polls.map.messageReferencePresent &&
        organiser.polls.map.open === "unverified",
      "Poll message not proof of open poll"
    );
    assert(
      organiser.timers.execution.includes("unverified") &&
        organiser.recoveryBlocked,
      "Timer and recovery uncertainty"
    );
    assert(
      organiser.recommendedNextChecks.some((check: string) =>
        check.includes("recovery block")
      ),
      "Actionable safe guidance"
    );
    const operationalText = JSON.stringify(organiser);
    assert(
      operationalText.length <= 4000,
      "One organiser snapshot fits the hosted tool-result limit"
    );
    assert(
      !operationalText.includes("secret recovery reason") &&
        !operationalText.includes("secret-poll-id"),
      "No raw recovery strings or IDs"
    );
    assert(
      game.getGameStartStatus() === "idle" && game.teams.RED.length === 1,
      "Snapshot did not mutate match"
    );

    assert(
      (
        (await executeAiTool("get_game_diagnostics", "{}", {
          ...user,
          verifyMembership: async () => ({ member: true, organiser: true }),
        })) as any
      ).persistence.includes("unknown"),
      "Legacy diagnostics compatibility"
    );
    try {
      await executeAiTool("get_game_diagnostics", "{}", user);
      assert(false, "Player denied organiser diagnostics");
    } catch (error) {
      assert(error instanceof AiToolDenied, "Role check enforced");
    }
  } finally {
    (MatchRecoveryGate as any).getBlockReason = originalBlock;
    game.reset();
  }
});

test("Unified game lifecycle distinguishes starting, started, finished and shutdown", async () => {
  const game = CurrentGameManager.getCurrentGame();
  try {
    game.reset();
    game.announced = true;
    assert(game.tryBeginGameStart() === "acquired", "Acquired start");
    assert(
      ((await executeAiTool("get_current_game_state", "{}", user)) as any)
        .lifecycle === "starting",
      "Starting stage"
    );
    game.completeGameStart();
    assert(
      ((await executeAiTool("get_current_game_state", "{}", user)) as any)
        .lifecycle === "started",
      "Started stage"
    );
    game.isFinished = true;
    assert(
      ((await executeAiTool("get_current_game_state", "{}", user)) as any)
        .lifecycle === "finished",
      "Finished stage"
    );
    game.isRestarting = true;
    assert(
      ((await executeAiTool("get_current_game_state", "{}", user)) as any)
        .lifecycle === "awaiting cleanup or shutdown",
      "Shutdown stage"
    );
  } finally {
    game.reset();
  }
});

test("Historical tool follows admission-like role rechecks and provider never sees upstream failure as a number", async () => {
  const original = prismaClient.player.findUnique;
  const harness = fixture();
  try {
    (prismaClient.player as any).findUnique = async () => ({
      latestIGN: "ExampleIGN",
    });
    let rounds = 0;
    const answer = await answerAiQuestion({
      question: "How many games did I win in season 8?",
      caller: user,
      organiser: false,
      knowledge: [],
      historicalClient: harness.client,
      infer: async (messages, tools) => {
        rounds++;
        assert(
          tools.some((t) => t.function.name === "get_my_historical_stats"),
          "Server-owned schema advertised"
        );
        if (rounds === 1)
          return {
            content: "",
            calls: [
              {
                id: "self-history",
                type: "function" as const,
                function: {
                  name: "get_my_historical_stats",
                  arguments: '{"season":8}',
                },
              },
            ],
          };
        const verified = messages.find(
          (msg) => msg.role === "tool" && msg.tool_call_id === "self-history"
        );
        assert(
          verified?.role === "tool" && JSON.parse(verified.content).wins === 9,
          "Projected historical DTO used"
        );
        return { content: "You won 9 games in season 8.", calls: [] };
      },
    });
    assert(
      answer.text.includes("9 games") && rounds === 2,
      "One safe historical tool round"
    );

    let failedRounds = 0;
    const failure = await answerAiQuestion({
      question: "What were my historical wins?",
      caller: user,
      organiser: false,
      knowledge: [],
      historicalClient: fixture(() => json({ error: "internal" }, 500)).client,
      infer: async () => {
        failedRounds++;
        return {
          content: "",
          calls: [
            {
              id: "fail",
              type: "function" as const,
              function: {
                name: "get_my_historical_stats",
                arguments: '{"season":8}',
              },
            },
          ],
        };
      },
    });
    assert(
      failedRounds === 1 && failure.text.includes("cannot verify"),
      "No extra inference after unavailable upstream data"
    );
  } finally {
    prismaClient.player.findUnique = original;
  }
});
