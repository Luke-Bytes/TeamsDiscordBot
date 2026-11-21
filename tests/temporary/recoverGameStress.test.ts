/**
 * Temporary, offline-only recovery stress suite.
 * Run separately from npm run tests:
 *   npx esbuild tests/temporary/run-recover-game.ts --bundle --platform=node --target=node18 --external:sharp --external:esbuild --outfile=dist/tests/recover-game-temporary.js
 *   node dist/tests/recover-game-temporary.js
 *
 * ALL channels, Prisma delegates, current game, and interaction responses are fake.
 * This file deliberately stays out of tests/run.ts.
 */
import { AnniClass, AnniMap, SeasonType } from "@prisma/client";
import { ConfigManager } from "../../src/ConfigManager";
import { GameInstance } from "../../src/database/GameInstance";
import { prismaClient } from "../../src/database/prismaClient";
import {
  GameSnapshotStore,
  GameRecoveryCoordinator,
} from "../../src/logic/ActiveGameRecovery";
import { MatchRecoveryGate } from "../../src/logic/MatchRecoveryGate";
import RecoverGameCommand from "../../src/commands/RecoverGameCommand";
import {
  buildDiscordRecovery,
  ensureRecoveryAllowed,
  installDiscordRecovery,
  parseAnnouncement,
  parseBans,
  parseDiscordMessageLink,
  parseModifiers,
  parseRegistration,
  parseTeams,
  RecoveryOptions,
} from "../../src/logic/DiscordGameRecovery";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";

const GUILD_ID = "111111111111111111";
const BOT_ID = "222222222222222222";
const ORGANISER_ID = "333333333333333333";
const OTHER_ID = "444444444444444444";
const CHANNELS = {
  announcements: "511111111111111111",
  botCommands: "522222222222222222",
  gameFeed: "533333333333333333",
  registration: "544444444444444444",
  teamPickingChat: "555555555555555555",
  redTeamChat: "566666666666666666",
  blueTeamChat: "577777777777777777",
};
const expected = <T>(actual: T, value: T, label: string) =>
  assertEqual(actual, value, label);
const reject = async (
  fn: () => unknown | Promise<unknown>,
  contains: string
) => {
  let error = "";
  try {
    await fn();
  } catch (caught) {
    error = String(caught);
  }
  assert(
    error.toLowerCase().includes(contains.toLowerCase()),
    `Expected error containing "${contains}", got "${error || "no error"}"`
  );
};
const redNames = ["RedCap", "RedTwo", "RedThree", "RedFour"];
const blueNames = ["BlueCap", "BlueTwo", "BlueThree", "BlueFour"];
const allNames = [...redNames, ...blueNames];
type FakeMessage = {
  id: string;
  url: string;
  channelId: string;
  createdTimestamp: number;
  content: string;
  embeds: any[];
  author: { id: string };
  client: { user: { id: string } };
  guildId: string;
  inGuild(): boolean;
};
type Fixture = ReturnType<typeof makeFixture>;
let nextMessage = 600000000000000001n;

function makeFixture() {
  const config = ConfigManager.getConfig();
  const originalChannels = { ...config.channels };
  const originalRoles = { ...config.roles };
  Object.assign(config.channels, CHANNELS);
  config.roles.organiserRole = "organiser-test-role";
  const now = Date.now();
  const startTime = new Date(now - 10 * 60_000);
  const messages = new Map<string, FakeMessage[]>();
  const records: any[] = allNames.map((name, index) => ({
    id: `player-${index}`,
    discordSnowflake: (700000000000000001n + BigInt(index)).toString(),
    minecraftAccounts: [name],
    primaryMinecraftAccount: `uuid-${index}`,
    latestIGN: name,
  }));
  const stats = new Map<string, any>(
    records.map((player, index) => [
      player.id,
      {
        playerId: player.id,
        seasonId: "season",
        elo: 1030 + index,
        wins: 4,
        losses: 3,
        winStreak: 2,
        loseStreak: 0,
        biggestWinStreak: 3,
        biggestLosingStreak: 2,
      },
    ])
  );
  const season: {
    id: string;
    number: number;
    type: SeasonType;
    isActive: boolean;
  } = { id: "season", number: 1, type: SeasonType.RANKED, isActive: true };
  const state = {
    existing: false,
    snapshotPending: false,
    incompletePublication: false,
    season,
    records,
    stats,
    dbCalls: [] as string[],
    writes: 0,
    blockedHistory: new Set<string>(),
    fetchError: new Map<string, Error>(),
  };
  const g: any = {
    id: GUILD_ID,
    client: { user: { id: BOT_ID } },
    channels: {
      fetch: async (id: string) => {
        if (state.blockedHistory.has(id)) throw new Error("Forbidden");
        const arr = messages.get(id) ?? [];
        return {
          id,
          messages: {
            fetch: async (query: any) => {
              const fetchError = state.fetchError.get(id);
              if (fetchError) throw fetchError;
              if (typeof query === "string") {
                const msg = arr.find((m) => m.id === query);
                if (!msg) throw new Error("Unknown Message");
                return msg;
              }
              const sorted = [...arr].sort(
                (a, b) => b.createdTimestamp - a.createdTimestamp
              );
              const before = query.before
                ? sorted.filter((m) => BigInt(m.id) < BigInt(query.before))
                : sorted;
              return new Map(
                before.slice(0, query.limit ?? 100).map((m) => [m.id, m])
              );
            },
          },
        };
      },
    },
    members: {
      fetch: async (id: string) => ({
        id,
        roles: {
          cache: {
            has: (role: string) =>
              id === ORGANISER_ID && role === config.roles.organiserRole,
          },
        },
      }),
    },
  };
  let sourceCount = 0;
  const message = (
    channelId: string,
    embeds: any[] = [],
    content = "",
    timestamp = now - 4 * 60_000,
    author = BOT_ID
  ): FakeMessage => {
    const id = (nextMessage++).toString();
    sourceCount++;
    const msg: FakeMessage = {
      id,
      url: `https://discord.com/channels/${GUILD_ID}/${channelId}/${id}`,
      channelId,
      createdTimestamp: timestamp,
      content,
      embeds,
      author: { id },
      client: g.client,
      guildId: GUILD_ID,
      inGuild: () => true,
    };
    msg.author.id = author;
    messages.set(channelId, [...(messages.get(channelId) ?? []), msg]);
    return msg;
  };
  const announce = (mod: any = {}) =>
    message(
      CHANNELS.announcements,
      [
        {
          title: "🎉 FRIENDLY WAR ANNOUNCEMENT",
          description: "🌟 A special DOUBLE ELO game! 🌟 Get ready to fight!",
          fields: [
            {
              name: "🕒 **TIME**",
              value: `**<t:${Math.round(startTime.getTime() / 1000)}:F>**`,
            },
            { name: "🗺️ **MAP**", value: "**Arid1v1**" },
            { name: "🚫 **BANNED CLASSES**", value: "Swapper" },
            {
              name: "⚙️ **MODIFIERS**",
              value: "**Nexus Damage: No Nexus Damage before phase 4 (Four)**",
            },
          ],
          footer: { text: "Organised by TestOrg - Hosted by TestHost" },
          ...mod,
        },
      ],
      "",
      now - 15 * 60_000
    );
  const register = (names = allNames, channel = CHANNELS.gameFeed) =>
    message(
      channel,
      [
        {
          title: `Registered Players (${names.length})`,
          description: `\`\`\`\n${names.join("\n")}\n\`\`\``,
          fields: [],
        },
      ],
      "",
      now - 3 * 60_000
    );
  const teams = (
    red = redNames,
    blue = blueNames,
    channel = CHANNELS.gameFeed
  ) =>
    message(
      channel,
      [
        {
          title: "Current Teams",
          fields: [
            { name: `🔴 Red Team [${red.length}]`, value: red.join("\n") },
            { name: `🔵 Blue Team [${blue.length}]`, value: blue.join("\n") },
          ],
        },
      ],
      "",
      now - 2 * 60_000
    );
  const draft = (
    red = redNames,
    blue = blueNames,
    title = "Snake Drafting Teams"
  ) =>
    message(
      CHANNELS.teamPickingChat,
      [
        {
          title,
          fields: [
            {
              name: "🔴 Red Team",
              value: red
                .map((name, idx) => `${idx === 0 ? "⚫" : "⚪"} ${name}`)
                .join("\n"),
            },
            {
              name: "🔵 Blue Team",
              value: blue
                .map((name, idx) => `${idx === 0 ? "⚫" : "⚪"} ${name}`)
                .join("\n"),
            },
          ],
        },
      ],
      "Teams have been finalised!",
      now - 2 * 60_000
    );
  const refs = {
    announcement: undefined as FakeMessage | undefined,
    registration: undefined as FakeMessage | undefined,
    teams: undefined as FakeMessage | undefined,
    draft: undefined as FakeMessage | undefined,
  };
  const populate = (includeTeams = true, includeDraft = true) => {
    refs.announcement = announce();
    refs.registration = register();
    if (includeTeams) refs.teams = teams();
    if (includeTeams && includeDraft) refs.draft = draft();
  };
  const original = {
    gameFind: (prismaClient.game as any).findFirst,
    playerFind: (prismaClient.player as any).findMany,
    statsFind: (prismaClient.playerStats as any).findUnique,
    seasonFind: (prismaClient.season as any).findFirst,
    snapshotPending: GameSnapshotStore.prototype.existsPending,
    snapshotIncomplete: GameSnapshotStore.prototype.hasIncompletePublication,
  };
  (prismaClient.game as any).findFirst = async (args: any) => {
    state.dbCalls.push("game.findFirst");
    if (!args?.where?.startTime?.gte || !args.where.startTime.lte)
      throw new Error("Missing DB time window");
    return state.existing ? { id: "already-saved" } : null;
  };
  (prismaClient.player as any).findMany = async () => {
    state.dbCalls.push("player.findMany");
    return state.records;
  };
  (prismaClient.playerStats as any).findUnique = async (args: any) => {
    state.dbCalls.push("playerStats.findUnique");
    return state.stats.get(args.where.playerId_seasonId.playerId) ?? null;
  };
  (prismaClient.season as any).findFirst = async () => {
    state.dbCalls.push("season.findFirst");
    return state.season;
  };
  GameSnapshotStore.prototype.existsPending = async () => state.snapshotPending;
  GameSnapshotStore.prototype.hasIncompletePublication = async () =>
    state.incompletePublication;
  const cleanup = () => {
    (prismaClient.game as any).findFirst = original.gameFind;
    (prismaClient.player as any).findMany = original.playerFind;
    (prismaClient.playerStats as any).findUnique = original.statsFind;
    (prismaClient.season as any).findFirst = original.seasonFind;
    GameSnapshotStore.prototype.existsPending = original.snapshotPending;
    GameSnapshotStore.prototype.hasIncompletePublication =
      original.snapshotIncomplete;
    Object.assign(config.channels, originalChannels);
    Object.assign(config.roles, originalRoles);
    GameInstance.getInstance().reset();
    GameRecoveryCoordinator.resetForTests();
    MatchRecoveryGate.block("");
  };
  const guild = g as any;
  const options = (
    phase: RecoveryOptions["phase"] = "teams"
  ): RecoveryOptions => ({ phase });
  const command = () =>
    new RecoverGameCommand({
      attachRecoveredAnnouncementMessage: (msg: unknown) => {
        state.dbCalls.push("announcementAttached");
        void msg;
      },
    } as any);
  const slash = (
    opts: RecoveryOptions,
    userId = ORGANISER_ID,
    authorised = true
  ) => {
    const responses: any[] = [];
    const values: any = {
      phase: opts.phase,
      announcement_link: opts.announcementLink,
      registered_link: opts.registeredLink,
      teams_link: opts.teamsLink,
      start_time: opts.startTime,
      map: opts.map,
      banned_classes: opts.bannedClasses,
      modifiers: opts.modifiers,
      double_elo: opts.doubleElo,
      organiser_name: opts.organiser,
      host_name: opts.host,
      selection_method: opts.selectionMethod,
      red_captain: opts.redCaptain,
      blue_captain: opts.blueCaptain,
    };
    const i: any = {
      guild,
      guildId: guild.id,
      user: { id: userId },
      member: {
        roles: {
          cache: {
            has: (id: string) =>
              authorised &&
              userId === ORGANISER_ID &&
              id === config.roles.organiserRole,
          },
        },
      },
      options: { getString: (key: string) => values[key] ?? null },
      reply: async (payload: any) => {
        responses.push(["reply", payload]);
        return {};
      },
      deferReply: async (payload: any) => {
        responses.push(["defer", payload]);
      },
      editReply: async (payload: any) => {
        responses.push(["edit", payload]);
        return {};
      },
    };
    return { i, responses };
  };
  const button = (
    customId: string,
    userId = ORGANISER_ID,
    guildOverride?: any
  ) => {
    const responses: any[] = [];
    const i: any = {
      customId,
      user: { id: userId },
      guild: guildOverride ?? guild,
      guildId: (guildOverride ?? guild).id,
      reply: async (payload: any) => {
        responses.push(["reply", payload]);
      },
      deferUpdate: async () => {
        responses.push(["defer"]);
      },
      update: async (payload: any) => {
        responses.push(["update", payload]);
      },
      editReply: async (payload: any) => {
        responses.push(["edit", payload]);
      },
    };
    return { i, responses };
  };
  const getButtonId = (responses: any[], n = 0) => {
    const rendered = responses.find(
      ([kind, payload]) => kind === "edit" && payload?.components?.length
    );
    assert(rendered, "Preview controls were published");
    return rendered[1].components[0].toJSON().components[n].custom_id as string;
  };
  return {
    guild,
    state,
    refs,
    messages,
    now,
    startTime,
    config,
    message,
    announce,
    register,
    teams,
    draft,
    populate,
    options,
    command,
    slash,
    button,
    getButtonId,
    cleanup,
  };
}
async function withFixture(
  work: (f: Fixture) => Promise<void> | void
): Promise<void> {
  GameRecoveryCoordinator.resetForTests();
  GameInstance.getInstance().reset();
  await MatchRecoveryGate.inspectPending(async () => []);
  const f = makeFixture();
  try {
    await work(f);
  } finally {
    f.cleanup();
    await MatchRecoveryGate.inspectPending(async () => []);
  }
}
function checkRoster(
  f: Fixture,
  p: Awaited<ReturnType<typeof buildDiscordRecovery>>
) {
  expected(
    p.teams.RED.map((x) => x.ignUsed).join(","),
    redNames.join(","),
    "red roster"
  );
  expected(
    p.teams.BLUE.map((x) => x.ignUsed).join(","),
    blueNames.join(","),
    "blue roster"
  );
  expected(p.teams.RED[0].elo, 1030, "original stats retained");
  expected(p.teams.RED[0].captain, true, "red captain");
  expected(p.teams.BLUE[0].captain, true, "blue captain");
}

// ---------------------------------------------------------------------
// Complete reconstruction and recovery installation
// ---------------------------------------------------------------------
test("TEMP recover: complete feed + draft reconstructs 8 players without mutation", () =>
  withFixture(async (f) => {
    f.populate();
    const p = await buildDiscordRecovery(f.guild, f.options());
    checkRoster(f, p);
    expected(p.teamsDecidedBy, "SNAKE_DRAFT", "draft method");
    expected(p.map, AnniMap.ARID1V1, "map");
    expected(p.bannedClasses[0], AnniClass.SWAPPER, "bans");
    expected(
      p.modifiers[0].name,
      "No Nexus Damage before phase 4 (Four)",
      "modifier"
    );
    expected(p.doubleElo, true, "elo flag");
    expected(p.organiser, "TestOrg", "organiser");
    expected(p.host, "TestHost", "host");
    assert(!GameInstance.getInstance().announced, "Preview is read-only");
    assert(!f.state.writes, "Database is read-only");
  }));
test("TEMP recover: installing teams preserves lifecycle and paused-workflow diagnostics", () =>
  withFixture(async (f) => {
    f.populate();
    const p = await buildDiscordRecovery(f.guild, f.options());
    installDiscordRecovery(p);
    const game = GameInstance.getInstance();
    assert(
      game.announced &&
        !!game.gameId &&
        game.gameId === game.getLifecycleToken(),
      "New stable game ID"
    );
    expected(game.teams.RED.length, 4, "red count");
    expected(game.teams.BLUE.length, 4, "blue count");
    expected(game.getGameStartStatus(), "idle", "teams picked, not started");
    expected(game.teamsDecidedBy, "SNAKE_DRAFT", "method");
    assert(
      game.recoveryPausedWorkflows.length >= 1,
      "Timers not assumed active"
    );
    assert(!f.state.writes, "No persistence");
  }));
test("TEMP recover: started games restore started flag and no-elo at low population", () =>
  withFixture(async (f) => {
    f.populate();
    const p = await buildDiscordRecovery(f.guild, f.options("started"));
    installDiscordRecovery(p);
    assert(
      GameInstance.getInstance().noElo,
      "Under 20 players cannot be rated"
    );
    expected(
      GameInstance.getInstance().getGameStartStatus(),
      "started",
      "started state"
    );
  }));
test("TEMP recover: announced-only recovers unassigned registration", () =>
  withFixture(async (f) => {
    f.populate(false);
    const p = await buildDiscordRecovery(f.guild, f.options("announced"));
    expected(p.teams.RED.length, 0, "no red");
    expected(p.teams.BLUE.length, 0, "no blue");
    expected(p.teams.UNDECIDED.length, 8, "8 unassigned");
    installDiscordRecovery(p);
    assert(
      !GameInstance.getInstance().hasFinalizedPlayableTeams(),
      "not playable"
    );
  }));
test("TEMP recover: manual fallback accepts explicit game settings when no announcement exists", () =>
  withFixture(async (f) => {
    f.register();
    f.teams();
    const p = await buildDiscordRecovery(f.guild, {
      ...f.options(),
      startTime: f.startTime.toISOString(),
      map: "ARID1V1",
      bannedClasses: "none",
      modifiers: "none",
      doubleElo: "no",
      selectionMethod: "ELO",
      organiser: "Manual",
      host: "ManualHost",
      redCaptain: "RedTwo",
      blueCaptain: "BlueThree",
    });
    expected(p.map, AnniMap.ARID1V1, "map");
    expected(p.teamsDecidedBy, "ELO", "manual method");
    expected(p.teams.RED[1].captain, true, "override red captain");
    expected(p.teams.BLUE[2].captain, true, "override blue captain");
    expected(p.doubleElo, false, "double elo off");
    assert(
      p.warnings.some((m) => m.includes("Announcement missing")),
      "manual warning"
    );
  }));
test("TEMP recover: captures organiser team-plan chat", () =>
  withFixture(async (f) => {
    f.populate();
    f.message(
      CHANNELS.redTeamChat,
      [],
      "Mid Blocks Plan\nRedCap = runner\nGame Plan\nRedCap = gear mid",
      f.now - 1000,
      ORGANISER_ID
    );
    const p = await buildDiscordRecovery(f.guild, f.options());
    expected(p.redPlan?.source, "CHANNEL", "plan source");
    assert((p.redPlan?.midBlocks ?? "").includes("runner"), "midblocks plan");
    assert((p.redPlan?.gamePlan ?? "").includes("gear mid"), "game plan");
  }));
test("TEMP recover: ignores bot template as a team plan", () =>
  withFixture(async (f) => {
    f.populate();
    f.message(
      CHANNELS.redTeamChat,
      [],
      "Mid Blocks Plan\nRedCap =\nGame Plan\nRedCap =",
      f.now - 1000
    );
    const p = await buildDiscordRecovery(f.guild, f.options());
    expected(
      p.redPlan,
      undefined,
      "template should not be mistaken for organiser plan"
    );
  }));
test("TEMP recover: alternative maps, multiple bans, multiple modifiers are parsed", () =>
  withFixture(async (f) => {
    f.register();
    f.teams();
    const p = await buildDiscordRecovery(f.guild, {
      ...f.options(),
      startTime: f.startTime.toISOString(),
      map: "Duelstal",
      bannedClasses: "Archer, Bloodmage, Swapper",
      modifiers: "Minerushing: Always; Nexus Damage: Phase 4",
      doubleElo: "yes",
      selectionMethod: "DRAFT",
    });
    expected(p.map, AnniMap.DUELSTAL, "map");
    expected(p.bannedClasses.length, 3, "bans");
    expected(p.modifiers.length, 2, "modifiers");
  }));
test("TEMP recover: relaxed season disables double-elo on install", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.season.type = SeasonType.RELAXED;
    const p = await buildDiscordRecovery(f.guild, f.options());
    assert(
      p.warnings.some((m) => m.includes("Season type differs")),
      "season mismatch warned"
    );
    installDiscordRecovery(p);
    assert(
      !GameInstance.getInstance().isDoubleElo,
      "ranked double elo not used in relaxed season"
    );
  }));
test("TEMP recover: when registration feed is missing, team roster is sufficient", () =>
  withFixture(async (f) => {
    f.announce();
    f.teams();
    f.draft();
    const p = await buildDiscordRecovery(f.guild, f.options());
    expected(p.teams.RED.length + p.teams.BLUE.length, 8, "full roster");
    assert(
      p.warnings.some((m) => m.includes("Registration feed missing")),
      "missing feed surfaced"
    );
  }));
test("TEMP recover: latest bot team feed wins over an earlier incomplete feed", () =>
  withFixture(async (f) => {
    f.populate();
    f.teams(["RedCap"], ["BlueCap"]);
    const p = await buildDiscordRecovery(f.guild, f.options());
    expected(
      p.teams.RED.length,
      4,
      "should use latest by createdTimestamp, not insertion order"
    );
  }));
test("TEMP recover: pagination scans beyond first 100 feed messages", () =>
  withFixture(async (f) => {
    f.populate();
    for (let n = 0; n < 110; n++)
      f.message(CHANNELS.gameFeed, [], "Unrelated event", f.now - 80_000 + n);
    const p = await buildDiscordRecovery(f.guild, f.options());
    expected(p.teams.RED.length, 4, "older feed reached across pages");
  }));

// ---------------------------------------------------------------------
// Fail-closed inputs and inconsistent evidence
// ---------------------------------------------------------------------
const missingOptions: Array<[string, Partial<RecoveryOptions>, string]> = [
  ["map", { map: "NotARealMap" }, "map is unknown"],
  ["bans", { bannedClasses: "GODMODE" }, "Unknown banned class"],
  ["modifier", { modifiers: "MissingSeparator" }, "Invalid modifier"],
  ["captain", { blueCaptain: "NotOnTeam" }, "captain is not a member"],
  [
    "no announcement/manual time",
    { announcementLink: "https://example.com/x" },
    "Message link",
  ],
];
for (const [name, change, reason] of missingOptions) {
  test(`TEMP recover: invalid ${name} fails before installation`, () =>
    withFixture(async (f) => {
      f.populate();
      await reject(
        () => buildDiscordRecovery(f.guild, { ...f.options(), ...change }),
        reason
      );
      assert(!GameInstance.getInstance().announced, "No installation");
    }));
}
test("TEMP recover: refuses no usable source messages", () =>
  withFixture(async (f) => {
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "Announcement not found"
    );
  }));
test("TEMP recover: manual fallback requires map, bans, modifiers and doubleElo", () =>
  withFixture(async (f) => {
    f.register();
    f.teams();
    const base = {
      ...f.options(),
      startTime: f.startTime.toISOString(),
      selectionMethod: "DRAFT" as const,
    };
    const variants: Array<[Partial<RecoveryOptions>, string]> = [
      [{}, "map is unknown"],
      [{ map: "ARID1V1" }, "Banned classes are unknown"],
      [{ map: "ARID1V1", bannedClasses: "none" }, "Modifiers are unknown"],
      [
        { map: "ARID1V1", bannedClasses: "none", modifiers: "none" },
        "Double ELO is unknown",
      ],
    ];
    for (const [changes, reason] of variants)
      await reject(
        () => buildDiscordRecovery(f.guild, { ...base, ...changes }),
        reason
      );
  }));
test("TEMP recover: unqualified/manual timestamps rejected", () =>
  withFixture(async (f) => {
    f.populate();
    for (const time of [
      "2026-11-20 22:00",
      "2026-11-20T22:00",
      "bad-time",
      "2026-13-20T22:00:00Z",
    ]) {
      await reject(
        () =>
          buildDiscordRecovery(f.guild, { ...f.options(), startTime: time }),
        "start_time"
      );
    }
  }));
test("TEMP recover: manually supplied time cannot disagree with original announcement", () =>
  withFixture(async (f) => {
    f.populate();
    await reject(
      () =>
        buildDiscordRecovery(f.guild, {
          ...f.options(),
          startTime: new Date(
            f.startTime.getTime() + 15 * 60_000
          ).toISOString(),
        }),
      "disagrees"
    );
  }));
test("TEMP recover: scheduled date outside allowed window rejected", () =>
  withFixture(async (f) => {
    f.register();
    f.teams();
    for (const shift of [-15, 35]) {
      await reject(
        () =>
          buildDiscordRecovery(f.guild, {
            ...f.options(),
            startTime: new Date(f.now + shift * 86_400_000).toISOString(),
          }),
        "last 14 days"
      );
    }
  }));
test("TEMP recover: declared roster count mismatch rejects truncated registration", () =>
  withFixture(async (f) => {
    f.populate();
    f.refs.registration!.embeds[0].title = "Registered Players (100)";
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "count does not match"
    );
  }));
test("TEMP recover: incomplete teams are rejected", () =>
  withFixture(async (f) => {
    f.announce();
    f.register();
    f.teams(["RedCap"], []);
    await reject(
      () =>
        buildDiscordRecovery(f.guild, {
          ...f.options(),
          selectionMethod: "DRAFT",
        }),
      "Team assignments are required"
    );
  }));
test("TEMP recover: 'announced' phase rejects evidence of already-picked teams", () =>
  withFixture(async (f) => {
    f.populate();
    await reject(
      () => buildDiscordRecovery(f.guild, f.options("announced")),
      "Teams exist"
    );
  }));
test("TEMP recover: missing selection method refuses non-draft current-team feed", () =>
  withFixture(async (f) => {
    f.announce();
    f.register();
    f.teams();
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "selection_method"
    );
  }));
test("TEMP recover: mismatched draft does not supply a selection method", () =>
  withFixture(async (f) => {
    f.announce();
    f.register();
    f.teams();
    f.draft(["RedCap"], ["BlueCap"]);
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "selection_method"
    );
  }));
test("TEMP recover: duplicate IGN across RED and BLUE refuses recovery", () =>
  withFixture(async (f) => {
    f.announce();
    f.register();
    f.teams(["RedCap", "BlueTwo"], ["BlueCap", "BlueTwo"]);
    f.draft(["RedCap", "BlueTwo"], ["BlueCap", "BlueTwo"]);
    await reject(() => buildDiscordRecovery(f.guild, f.options()), "duplicate");
  }));
test("TEMP recover: duplicate database identity across two IGNs refuses recovery", () =>
  withFixture(async (f) => {
    f.populate();
    const record = f.state.records.find((p: any) => p.latestIGN === "RedCap");
    record.minecraftAccounts.push("BlueCap");
    f.state.records.splice(
      f.state.records.findIndex((p: any) => p.latestIGN === "BlueCap"),
      1
    );
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "same Discord member"
    );
  }));
test("TEMP recover: unknown IGN refuses recovery without creating player", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.records.splice(
      f.state.records.findIndex((p: any) => p.latestIGN === "BlueCap"),
      1
    );
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "Cannot uniquely match"
    );
    expected(f.state.writes, 0, "no DB writes");
  }));
test("TEMP recover: latest IGN wins over a former owner's historical alias", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.records[1].minecraftAccounts.push("RedCap");
    const proposal = await buildDiscordRecovery(f.guild, f.options());
    expected(proposal.teams.RED[0].playerId, "player-0", "Current IGN owner");
    expected(
      proposal.teams.BLUE[0].playerId,
      "player-4",
      "Other roster unchanged"
    );
    expected(
      f.state.writes,
      0,
      "No database mutation for current IGN resolution"
    );
  }));

test("TEMP recover: same current IGN on two Discord users is genuinely ambiguous", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.records[1].latestIGN = "rEdCaP";
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "Cannot uniquely match"
    );
  }));

test("TEMP recover: ambiguous historical aliases without a current owner still block", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.records[0].latestIGN = "FormerRed";
    f.state.records[1].minecraftAccounts.push("RedCap");
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "Cannot uniquely match"
    );
  }));

test("TEMP recover: a unique historical alias can be recovered with a warning", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.records[0].latestIGN = "FormerRed";
    const proposal = await buildDiscordRecovery(f.guild, f.options());
    expected(
      proposal.teams.RED[0].playerId,
      "player-0",
      "Unique historical match"
    );
    assert(
      proposal.warnings.some(
        (message) =>
          message.includes("RedCap") && message.includes("historical")
      ),
      "Historical identity fallback is disclosed for organiser review"
    );
  }));

test("TEMP recover: duplicate primary Minecraft UUIDs still block current IGN resolution", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.records[1].primaryMinecraftAccount =
      f.state.records[0].primaryMinecraftAccount;
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "Minecraft UUID"
    );
  }));
test("TEMP recover: missing season stats refuses recovery", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.stats.delete("player-0");
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "No season stats"
    );
  }));
test("TEMP recover: Discord bot spoofed by member is not trusted", () =>
  withFixture(async (f) => {
    f.populate();
    f.refs.teams!.author.id = OTHER_ID;
    await reject(
      () =>
        buildDiscordRecovery(f.guild, {
          ...f.options(),
          teamsLink: f.refs.teams!.url,
        }),
      "sent by this bot"
    );
  }));
test("TEMP recover: wrong source link type rejected", () =>
  withFixture(async (f) => {
    f.populate();
    await reject(
      () =>
        buildDiscordRecovery(f.guild, {
          ...f.options(),
          registeredLink: f.refs.teams!.url,
        }),
      "matching message"
    );
  }));
test("TEMP recover: linked message outside game period rejected", () =>
  withFixture(async (f) => {
    f.populate();
    f.refs.teams!.createdTimestamp = f.startTime.getTime() - 30 * 60 * 60_000;
    await reject(
      () =>
        buildDiscordRecovery(f.guild, {
          ...f.options(),
          teamsLink: f.refs.teams!.url,
        }),
      "another game period"
    );
  }));
test("TEMP recover: /game end without database save restores post-game state", () =>
  withFixture(async (f) => {
    f.populate();
    const end = f.message(
      CHANNELS.redTeamChat,
      [],
      "The game has now ended, voting for the team MVP is now open!",
      f.now - 1000
    );
    const proposal = await buildDiscordRecovery(f.guild, f.options("started"));
    expected(
      proposal.recoveredEndTime?.getTime(),
      end.createdTimestamp,
      "End time"
    );
    assert(
      proposal.warnings.some((w) => w.includes("MVP votes")),
      "Lost MVP votes warning"
    );
    assert(
      proposal.sourceSummary.some((s) => s.includes(end.url)),
      "End evidence displayed"
    );
    installDiscordRecovery(proposal);
    const game = GameInstance.getInstance();
    assert(game.isFinished, "Recovered game remains ended");
    expected(
      game.endTime?.getTime(),
      end.createdTimestamp,
      "Restored end time"
    );
    expected(
      game.getGameStartStatus(),
      "started",
      "Started lifecycle retained"
    );
    assert(
      game.redExpectedScore !== undefined,
      "Post-game ELO expectations restored"
    );
    expected(f.state.writes, 0, "No database writes during recovery");
  }));
test("TEMP recover: game-over feed without persisted match is reviewable", () =>
  withFixture(async (f) => {
    f.populate();
    f.message(CHANNELS.gameFeed, [], "🎉 The Game is Over! 🎉", f.now - 1000);
    const proposal = await buildDiscordRecovery(f.guild, f.options("started"));
    assert(!!proposal.recoveredEndTime, "Post-game state is recognised");
    assert(
      proposal.warnings.some((w) => w.includes("no saved match")),
      "Unsaved status warned"
    );
  }));
test("TEMP recover: cleanup announcement still defers to database commitment", () =>
  withFixture(async (f) => {
    f.populate();
    f.message(
      CHANNELS.botCommands,
      [],
      "Beginning post game clean up",
      f.now - 1000
    );
    const proposal = await buildDiscordRecovery(f.guild, f.options("started"));
    assert(!!proposal.recoveredEndTime, "Uncommitted cleanup is recoverable");
    f.state.existing = true;
    await reject(
      () => buildDiscordRecovery(f.guild, f.options("started")),
      "already stored"
    );
  }));
test("TEMP recover: member-authored game-end text cannot change recovery phase", () =>
  withFixture(async (f) => {
    f.populate();
    f.message(
      CHANNELS.redTeamChat,
      [],
      "The game has now ended, voting for the team MVP is now open!",
      f.now - 1000,
      OTHER_ID
    );
    const proposal = await buildDiscordRecovery(f.guild, f.options("teams"));
    expected(proposal.recoveredEndTime, undefined, "Untrusted message ignored");
  }));

test("TEMP recover: later game's end signal is not attributed to linked game", () =>
  withFixture(async (f) => {
    f.populate();
    f.announce(); // New announcement after the linked game's evidence.
    const laterAnnouncement = f.messages.get(CHANNELS.announcements)!.at(-1)!;
    laterAnnouncement.createdTimestamp = f.now - 1500;
    f.message(CHANNELS.gameFeed, [], "The game has now ended", f.now - 1000);
    const proposal = await buildDiscordRecovery(f.guild, {
      ...f.options("started"),
      announcementLink: f.refs.announcement!.url,
    });
    expected(proposal.recoveredEndTime, undefined, "Later game ignored");
  }));

test("TEMP recover: game-end message edited after preview must be approved again", () =>
  withFixture(async (f) => {
    f.populate();
    const ended = f.message(
      CHANNELS.redTeamChat,
      [],
      "The game has now ended, voting for the team MVP is now open!",
      f.now - 1000
    );
    const command = f.command();
    const request = f.slash(f.options("started"));
    await command.execute(request.i);
    ended.content += " Please vote again.";
    await command.handleButtonPress(
      f.button(f.getButtonId(request.responses)).i
    );
    assert(
      !GameInstance.getInstance().announced,
      "Edited end evidence invalidates preview"
    );
  }));

test("TEMP recover: ended and unsaved game confirms into post-game lifecycle", () =>
  withFixture(async (f) => {
    f.populate();
    f.message(
      CHANNELS.blueTeamChat,
      [],
      "The game has now ended",
      f.now - 1000
    );
    const command = f.command();
    const request = f.slash(f.options("started"));
    await command.execute(request.i);
    const preview = request.responses.find(
      ([kind, payload]: any[]) => kind === "edit" && payload.embeds?.length
    );
    assert(!!preview, "Ended game has a recoverable preview");
    assert(
      preview[1].embeds[0].data.description.includes(
        "already ended; not saved"
      ),
      "Organiser sees ended state before confirmation"
    );
    await command.handleButtonPress(
      f.button(f.getButtonId(request.responses)).i
    );
    assert(
      GameInstance.getInstance().isFinished,
      "Recovery confirmed as ended"
    );
  }));

test("TEMP recover: unreadable optional channel produces warning without inventing plans", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.fetchError.set(CHANNELS.blueTeamChat, new Error("Forbidden"));
    const p = await buildDiscordRecovery(f.guild, f.options());
    assert(
      p.warnings.some((w) => w.includes("Could not read")),
      "Unreadable history shown to organiser"
    );
    expected(p.bluePlan, undefined, "no invented plan");
  }));

// ---------------------------------------------------------------------
// Persistence, snapshot, phase and process guards
// ---------------------------------------------------------------------
test("TEMP recover: currently active game cannot be overwritten", () =>
  withFixture(async (f) => {
    f.populate();
    GameInstance.getInstance().beginConfirmedAnnouncement();
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "already a current game"
    );
  }));
test("TEMP recover: finished leftover in-memory game cannot be overwritten", () =>
  withFixture(async (f) => {
    f.populate();
    GameInstance.getInstance().isFinished = true;
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "already a current game"
    );
  }));
test("TEMP recover: started leftover in-memory state cannot be overwritten", () =>
  withFixture(async (f) => {
    f.populate();
    GameInstance.getInstance().tryBeginGameStart();
    GameInstance.getInstance().completeGameStart();
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "already a current game"
    );
  }));
test("TEMP recover: matching persisted match blocks recovery", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.existing = true;
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "already stored"
    );
    assert(
      f.state.dbCalls.includes("game.findFirst"),
      "DB safety read happened"
    );
  }));
test("TEMP recover: pending planned-restart snapshot blocks recovery", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.snapshotPending = true;
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "restart snapshot"
    );
  }));
test("TEMP recover: interrupted snapshot publication blocks recovery", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.incompletePublication = true;
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "restart snapshot"
    );
  }));
test("TEMP recover: pending committed match cleanup blocks recovery", () =>
  withFixture(async (f) => {
    f.populate();
    MatchRecoveryGate.block("pending match-123");
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "cleanup is unresolved"
    );
  }));
test("TEMP recover: game lifecycle conflict prevents installation", () =>
  withFixture(async (f) => {
    f.populate();
    const p = await buildDiscordRecovery(f.guild, f.options());
    GameInstance.getInstance().beginConfirmedAnnouncement();
    await reject(() => installDiscordRecovery(p), "Current game changed");
  }));
test("TEMP recover: frozen coordinator prevents installation at announcement", () =>
  withFixture(async (f) => {
    f.populate();
    const p = await buildDiscordRecovery(f.guild, f.options());
    GameRecoveryCoordinator.beginStartup();
    await reject(() => installDiscordRecovery(p), "recovery is unresolved");
    GameRecoveryCoordinator.finishStartup(null);
  }));
test("TEMP recover: no fresh DB records are written during proposal and installation", () =>
  withFixture(async (f) => {
    f.populate();
    await buildDiscordRecovery(f.guild, f.options()).then(
      installDiscordRecovery
    );
    expected(f.state.writes, 0, "no database mutations");
  }));

// ---------------------------------------------------------------------
// Slash command preview and single-use confirmation
// ---------------------------------------------------------------------
test("TEMP command: slash command exposes all options and button routing", () =>
  withFixture((f) => {
    const c = f.command();
    const data = c.data.toJSON();
    expected(data.name, "recover-game", "name");
    assert(
      data.options?.some((o: any) => o.name === "phase" && o.required),
      "phase required"
    );
    assert(
      c.buttonIds.some((s) => s.startsWith("recover-game-confirm:")),
      "confirm routed"
    );
  }));
test("TEMP command: organiser gets ephemeral preview and game remains untouched", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const { i, responses } = f.slash(f.options());
    await c.execute(i);
    const preview = responses.find(
      ([kind, p]) => kind === "edit" && p.components
    );
    assert(preview, "interactive preview");
    assert(
      responses.some(([kind, p]) => kind === "defer" && p.flags),
      "ephemeral defer"
    );
    assert(
      !GameInstance.getInstance().announced,
      "no mutation before confirmation"
    );
  }));
test("TEMP command: unauthorised user never scans Discord", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const { i, responses } = f.slash(f.options(), OTHER_ID, false);
    await c.execute(i);
    assert(
      responses.some(([kind]) => kind === "reply"),
      "reject user"
    );
    expected(f.state.dbCalls.length, 0, "no DB reads");
  }));
test("TEMP command: confirm restores once and attaches original announcement", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const confirmation = f.button(f.getButtonId(interaction.responses));
    await c.handleButtonPress(confirmation.i);
    assert(GameInstance.getInstance().announced, "confirmed recovery");
    assert(
      f.state.dbCalls.includes("announcementAttached"),
      "announcement attached"
    );
    assert(
      confirmation.responses.some(
        ([kind, payload]) =>
          kind === "edit" && payload?.content?.includes("Game reconstructed")
      ),
      "acknowledgement"
    );
    const replay = f.button(f.getButtonId(interaction.responses));
    await c.handleButtonPress(replay.i);
    assert(
      replay.responses.some(
        ([kind, payload]) =>
          kind === "reply" && payload?.content?.includes("expired")
      ),
      "replay refused"
    );
  }));
test("TEMP command: cancellation leaves memory unchanged", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const confirmation = f.button(f.getButtonId(interaction.responses, 1));
    await c.handleButtonPress(confirmation.i);
    assert(!GameInstance.getInstance().announced, "cancelled");
    assert(
      confirmation.responses.some(([kind]) => kind === "update"),
      "cancel acknowledged"
    );
  }));
test("TEMP command: wrong clicker cannot consume preview", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const id = f.getButtonId(interaction.responses);
    const wrong = f.button(id, OTHER_ID);
    await c.handleButtonPress(wrong.i);
    assert(
      !GameInstance.getInstance().announced,
      "wrong clicker did not install"
    );
    const correct = f.button(id);
    await c.handleButtonPress(correct.i);
    assert(
      GameInstance.getInstance().announced,
      "valid clicker can still recover"
    );
  }));
test("TEMP command: revoked organiser role blocks confirmation", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const old = f.guild.members.fetch;
    f.guild.members.fetch = async () => ({
      roles: { cache: { has: () => false } },
    });
    try {
      const button = f.button(f.getButtonId(interaction.responses));
      await c.handleButtonPress(button.i);
      assert(
        !GameInstance.getInstance().announced,
        "revoked role does not recover"
      );
      assert(
        button.responses.some(
          ([kind, payload]) =>
            kind === "reply" && payload?.content?.includes("no longer")
        ),
        "reason shown"
      );
    } finally {
      f.guild.members.fetch = old;
    }
  }));
test("TEMP command: wrong guild confirmation refused", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const button = f.button(
      f.getButtonId(interaction.responses),
      ORGANISER_ID,
      {
        ...f.guild,
        id: "999999999999999999",
      }
    );
    await c.handleButtonPress(button.i);
    assert(
      !GameInstance.getInstance().announced,
      "other server cannot confirm"
    );
  }));
test("TEMP command: stale lifecycle invalidates preview", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    GameInstance.getInstance().reset();
    const button = f.button(f.getButtonId(interaction.responses));
    await c.handleButtonPress(button.i);
    assert(!GameInstance.getInstance().announced, "stale preview");
    assert(
      button.responses.some(
        ([kind, payload]) =>
          kind === "edit" && payload?.content?.includes("lifecycle changed")
      ),
      "error shown"
    );
  }));
test("TEMP command: stale Discord team changes invalidate preview", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash({
      ...f.options(),
      selectionMethod: "SNAKE_DRAFT",
    });
    await c.execute(interaction.i);
    f.refs.teams!.embeds[0].fields[0].value =
      "RedCap\nRedTwo\nRedThree\nBlueFour";
    f.refs.teams!.embeds[0].fields[1].value =
      "BlueCap\nBlueTwo\nBlueThree\nRedFour";
    const button = f.button(f.getButtonId(interaction.responses));
    await c.handleButtonPress(button.i);
    assert(
      !GameInstance.getInstance().announced,
      "changed roster cannot install"
    );
    assert(
      button.responses.some(
        ([kind, payload]) =>
          kind === "edit" && payload?.content?.includes("changed since")
      ),
      "explicit stale evidence error"
    );
  }));
test("TEMP command: newly saved match between preview and confirm blocks installation", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    f.state.existing = true;
    const button = f.button(f.getButtonId(interaction.responses));
    await c.handleButtonPress(button.i);
    assert(
      !GameInstance.getInstance().announced,
      "DB committed, cannot recover"
    );
  }));
test("TEMP command: pending snapshot between preview and confirm blocks installation", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    f.state.snapshotPending = true;
    const button = f.button(f.getButtonId(interaction.responses));
    await c.handleButtonPress(button.i);
    assert(!GameInstance.getInstance().announced, "snapshot conflict");
  }));
test("TEMP command: second confirmation after cancellation is rejected", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    await c.handleButtonPress(
      f.button(f.getButtonId(interaction.responses, 1)).i
    );
    const replay = f.button(f.getButtonId(interaction.responses));
    await c.handleButtonPress(replay.i);
    assert(!GameInstance.getInstance().announced, "cancel consumed nonce");
  }));
test("TEMP command: expired confirmation never installs", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const pending = (c as any).pending as Map<string, any>;
    const entry = [...pending.values()][0];
    entry.expiresAt = Date.now() - 1;
    await c.handleButtonPress(f.button(f.getButtonId(interaction.responses)).i);
    assert(!GameInstance.getInstance().announced, "expired");
  }));
test("TEMP command: rechecking changed player Elo invalidates preview", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    f.state.stats.get("player-0").elo += 20;
    const button = f.button(f.getButtonId(interaction.responses));
    await c.handleButtonPress(button.i);
    assert(!GameInstance.getInstance().announced, "changed Elo");
  }));
test("TEMP command: duplicate near-simultaneous confirm cannot install twice", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const id = f.getButtonId(interaction.responses);
    await Promise.all([
      c.handleButtonPress(f.button(id).i),
      c.handleButtonPress(f.button(id).i),
    ]);
    assert(GameInstance.getInstance().announced, "one accepted");
    assert(
      GameInstance.getInstance().gameId !== undefined,
      "one stable identity"
    );
  }));
test("TEMP command: missing source responds with error and no buttons", () =>
  withFixture(async (f) => {
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    assert(
      interaction.responses.some(
        ([kind, p]) => kind === "edit" && p.content?.includes("preview failed")
      ),
      "error shown"
    );
    assert(!GameInstance.getInstance().announced, "no mutation");
  }));

test("TEMP recover: 26-player roster and 20-player rating threshold are restored", () =>
  withFixture(async (f) => {
    const moreRed = Array.from({ length: 9 }, (_, i) => `RedExtra${i}`);
    const moreBlue = Array.from({ length: 9 }, (_, i) => `BlueExtra${i}`);
    for (const [i, ign] of [...moreRed, ...moreBlue].entries()) {
      const id = `player-extra-${i}`;
      f.state.records.push({
        id,
        discordSnowflake: (800000000000000001n + BigInt(i)).toString(),
        minecraftAccounts: [ign],
        latestIGN: ign,
        primaryMinecraftAccount: `extra-${i}`,
      });
      f.state.stats.set(id, {
        playerId: id,
        seasonId: "season",
        elo: 1000 + i,
        wins: 0,
        losses: 0,
        winStreak: 0,
        loseStreak: 0,
        biggestWinStreak: 0,
        biggestLosingStreak: 0,
      });
    }
    f.announce();
    f.register([...allNames, ...moreRed, ...moreBlue]);
    f.teams([...redNames, ...moreRed], [...blueNames, ...moreBlue]);
    f.draft([...redNames, ...moreRed], [...blueNames, ...moreBlue]);
    const proposal = await buildDiscordRecovery(f.guild, f.options("started"));
    expected(proposal.teams.RED.length, 13, "red 13");
    expected(proposal.teams.BLUE.length, 13, "blue 13");
    installDiscordRecovery(proposal);
    assert(
      !GameInstance.getInstance().noElo,
      "At 26 players recovery is rated"
    );
  }));

test("TEMP adversarial: late signups from registration feed survive installation", () =>
  withFixture(async (f) => {
    f.announce();
    const registration = f.register(allNames.slice(0, 7));
    registration.embeds[0].fields.push({
      name: "Late Signups (1)",
      value: "```\nBlueFour\n```",
    });
    const proposal = await buildDiscordRecovery(
      f.guild,
      f.options("announced")
    );
    installDiscordRecovery(proposal);
    const lateDiscordId = f.state.records.find(
      (p: any) => p.latestIGN === "BlueFour"
    ).discordSnowflake;
    assert(
      GameInstance.getInstance().lateSignups.has(lateDiscordId),
      "Recovered late sign-up flag must not be silently dropped"
    );
  }));
test("TEMP adversarial: truncated late signups list is rejected", () =>
  withFixture(async (f) => {
    f.announce();
    const registration = f.register(allNames);
    registration.embeds[0].fields.push({
      name: "Late Signups (3)",
      value: "```\nSomebody\n```",
    });
    await reject(
      () => parseRegistration({ embeds: registration.embeds } as any),
      "Late Signups"
    );
  }));
test("TEMP adversarial: organiser/host edits since preview require a new confirmation", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    f.refs.announcement!.embeds[0].footer.text =
      "Organised by NewOrganiser - Hosted by NewHost";
    const button = f.button(f.getButtonId(interaction.responses));
    await c.handleButtonPress(button.i);
    assert(
      !GameInstance.getInstance().announced,
      "Metadata not approved by organiser must not be installed"
    );
  }));
test("TEMP adversarial: active season change since preview requires a new confirmation", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    f.state.season.type = SeasonType.RELAXED;
    const button = f.button(f.getButtonId(interaction.responses));
    await c.handleButtonPress(button.i);
    assert(
      !GameInstance.getInstance().announced,
      "Changed season rating rules must invalidate preview"
    );
  }));
test("TEMP adversarial: winner/stat history edits since preview require new confirmation", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    f.state.stats.get("player-0").wins += 1;
    await c.handleButtonPress(f.button(f.getButtonId(interaction.responses)).i);
    assert(
      !GameInstance.getInstance().announced,
      "Stats changes other than ELO must invalidate preview"
    );
  }));
test("TEMP adversarial: team plan edits since preview require new confirmation", () =>
  withFixture(async (f) => {
    f.populate();
    const plan = f.message(
      CHANNELS.redTeamChat,
      [],
      "Mid Blocks Plan\nRedCap = runner\nGame Plan\nRedCap = gear mid",
      f.now - 1000,
      ORGANISER_ID
    );
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    plan.content =
      "Mid Blocks Plan\nRedCap = wizard\nGame Plan\nRedCap = stay gold";
    await c.handleButtonPress(f.button(f.getButtonId(interaction.responses)).i);
    assert(
      !GameInstance.getInstance().announced,
      "Plan changes must invalidate preview"
    );
  }));
test("TEMP adversarial: an in-progress draft embed cannot masquerade as final teams", () =>
  withFixture(async (f) => {
    f.announce();
    f.register();
    f.message(
      CHANNELS.teamPickingChat,
      [
        {
          title: "Snake Drafting Teams",
          fields: [
            { name: "🔴 Red Team", value: "⚪ RedCap\n⚪ RedTwo" },
            { name: "🔵 Blue Team", value: "⚪ BlueCap\n⚪ BlueTwo" },
            {
              name: "🟢 Up for Grabs",
              value: "⚪ RedThree\n⚪ RedFour\n⚪ BlueThree\n⚪ BlueFour",
            },
          ],
        },
      ],
      "It is Red team's turn",
      f.now - 2000
    );
    await reject(
      () => buildDiscordRecovery(f.guild, f.options("started")),
      "final"
    );
  }));

test("TEMP adversarial: multiple recent announcements require an explicit source", () =>
  withFixture(async (f) => {
    f.populate();
    f.announce();
    await reject(() => buildDiscordRecovery(f.guild, f.options()), "multiple");
  }));

test("TEMP adversarial: registration from an earlier game is not mixed into the roster", () =>
  withFixture(async (f) => {
    f.populate();
    f.refs.registration!.createdTimestamp = f.now - 30 * 60_000;
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "announcement"
    );
  }));

test("TEMP adversarial: wrong source channel is not accepted even for bot messages", () =>
  withFixture(async (f) => {
    f.populate();
    f.refs.registration!.channelId = CHANNELS.blueTeamChat;
    f.refs.registration!.url = `https://discord.com/channels/${GUILD_ID}/${CHANNELS.blueTeamChat}/${f.refs.registration!.id}`;
    const replacement = f.message(
      CHANNELS.blueTeamChat,
      f.refs.registration!.embeds
    );
    await reject(
      () =>
        buildDiscordRecovery(f.guild, {
          ...f.options(),
          registeredLink: replacement.url,
        }),
      "channel"
    );
  }));

test("TEMP adversarial: unreadable game feed refuses recovery rather than hiding end signals", () =>
  withFixture(async (f) => {
    f.populate();
    f.state.blockedHistory.add(CHANNELS.gameFeed);
    await reject(() => buildDiscordRecovery(f.guild, f.options()), "game feed");
  }));

test("TEMP adversarial: scanning only 400 of 450 messages refuses incomplete evidence", () =>
  withFixture(async (f) => {
    f.populate();
    for (let n = 0; n < 450; n++) {
      f.message(CHANNELS.gameFeed, [], "noise", f.now - 45_000 + n * 100);
    }
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "pagination"
    );
  }));

test("TEMP adversarial: completed draft waiting for Accept is not confirmed", () =>
  withFixture(async (f) => {
    f.announce();
    f.register();
    const draft = f.draft();
    draft.content = "All players have been drafted! Here is the final draft.";
    draft.embeds[0].footer = { text: "Select an action below." };
    await reject(
      () => buildDiscordRecovery(f.guild, f.options("started")),
      "final"
    );
  }));

test("TEMP adversarial: duplicate Late Signups fields are refused", () =>
  withFixture(async (f) => {
    const registration = f.register();
    registration.embeds[0].fields = [
      { name: "Late Signups (1)", value: "BlueFour" },
      { name: "Late Signups (1)", value: "BlueThree" },
    ];
    await reject(
      () => parseRegistration(registration as any),
      "Multiple Late Signups"
    );
  }));

test("TEMP adversarial: repeated IGN across regular and late registrations is refused", () =>
  withFixture(async (f) => {
    const registration = f.register();
    registration.embeds[0].fields.push({
      name: "Late Signups (1)",
      value: "RedCap",
    });
    await reject(() => parseRegistration(registration as any), "duplicate");
  }));

test("TEMP adversarial: edited plan source that parses identically invalidates preview", () =>
  withFixture(async (f) => {
    f.populate();
    const plan = f.message(
      CHANNELS.redTeamChat,
      [],
      "Mid Blocks Plan\nRedCap = runner\nGame Plan\nRedCap = gear mid",
      f.now - 1000,
      ORGANISER_ID
    );
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    plan.content += "\n\n";
    await c.handleButtonPress(f.button(f.getButtonId(interaction.responses)).i);
    assert(
      !GameInstance.getInstance().announced,
      "Any source edit should require new approval"
    );
  }));

test("TEMP adversarial: switching active season ID with same rules invalidates preview", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    f.state.season.id = "other-season";
    await c.handleButtonPress(f.button(f.getButtonId(interaction.responses)).i);
    assert(
      !GameInstance.getInstance().announced,
      "Season identity was changed"
    );
  }));

test("TEMP adversarial: player account mapping changes invalidate preview", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    f.state.records[0].primaryMinecraftAccount = "different-uuid";
    await c.handleButtonPress(f.button(f.getButtonId(interaction.responses)).i);
    assert(!GameInstance.getInstance().announced, "Player mapping was changed");
  }));

test("TEMP adversarial: team plans must appear in organiser's preview", () =>
  withFixture(async (f) => {
    f.populate();
    f.message(
      CHANNELS.redTeamChat,
      [],
      "Mid Blocks Plan\nRedCap = runner\nGame Plan\nRedCap = gear mid",
      f.now - 1000,
      ORGANISER_ID
    );
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const preview = interaction.responses.find(
      ([kind, payload]: any[]) => kind === "edit" && payload.embeds?.length
    );
    const fields = preview?.[1].embeds[0].data.fields ?? [];
    assert(
      fields.some(
        (field: any) =>
          field.name.includes("Red plan") && field.value.includes("runner")
      ),
      "Preview must show recovered plan content"
    );
  }));

test("TEMP lifecycle: separate bot finalisation message confirms the accepted draft", () =>
  withFixture(async (f) => {
    f.populate();
    f.refs.draft!.content =
      "All players have been drafted! Here is the final draft.";
    f.refs.draft!.embeds[0].footer = { text: "Blue Team: 1000 Red Team: 1000" };
    f.message(
      CHANNELS.teamPickingChat,
      [],
      "Teams have been finalised!",
      f.now - 1000
    );
    const proposal = await buildDiscordRecovery(f.guild, f.options("started"));
    expected(proposal.teamsDecidedBy, "SNAKE_DRAFT", "Accepted draft method");
  }));

test("TEMP lifecycle: unconfirmed final-looking draft cannot supply selection method", () =>
  withFixture(async (f) => {
    f.populate();
    f.refs.draft!.content =
      "All players have been drafted! Here is the final draft.";
    f.refs.draft!.embeds[0].footer = { text: "Select an action below." };
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "selection_method"
    );
  }));

test("TEMP lifecycle: a draft with waiting late players cannot be treated as final", () =>
  withFixture(async (f) => {
    f.announce();
    f.register();
    const draft = f.draft();
    draft.embeds[0].fields.push({
      name: "Late Signups [1]",
      value: "RedThree",
    });
    await reject(
      () => buildDiscordRecovery(f.guild, f.options("started")),
      "final"
    );
  }));

test("TEMP integrity: final team roster cannot silently include an unregistered player", () =>
  withFixture(async (f) => {
    f.populate();
    f.refs.registration!.embeds[0].title = "Registered Players (7)";
    f.refs.registration!.embeds[0].description = `\`\`\`\n${allNames.slice(0, 7).join("\n")}\n\`\`\``;
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "registration"
    );
  }));

test("TEMP integrity: malformed registration entry cannot be partially parsed", () =>
  withFixture(async (f) => {
    const registration = f.register();
    registration.embeds[0].title = "Registered Players (1)";
    registration.embeds[0].description = "Someone unrelated RedCap";
    await reject(
      () => parseRegistration(registration as any),
      "Malformed player list"
    );
  }));

test("TEMP integrity: repeated team fields cannot replace source roster", () =>
  withFixture(async (f) => {
    const teams = f.teams();
    teams.embeds[0].fields.push({ name: "Red Team [1]", value: "RedCap" });
    await reject(() => parseTeams(teams as any), "Duplicate RED");
  }));

test("TEMP preview: oversized recovered plan is refused rather than silently truncated", () =>
  withFixture(async (f) => {
    f.populate();
    f.message(
      CHANNELS.redTeamChat,
      [],
      "Mid Blocks Plan\nRedCap = " +
        "A".repeat(1200) +
        "\nGame Plan\nRedCap = gear mid",
      f.now - 1000,
      ORGANISER_ID
    );
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const response = interaction.responses.find(
      ([kind, payload]: any[]) =>
        kind === "edit" &&
        typeof payload.content === "string" &&
        payload.content.includes("Recovery preview failed")
    );
    assert(
      !!response,
      "Oversized unreviewable content must not install or offer confirmation"
    );
  }));

test("TEMP parser: actual Discord draft shortcodes and ELO labels are recovered", () =>
  withFixture(async (f) => {
    const draft = f.draft();
    draft.embeds[0].fields = [
      {
        name: "🔴 Red Team",
        value: "**\t\t:black_circle: RedCap**\n\t\t:white_circle: RedTwo",
      },
      {
        name: "🔵 Blue Team",
        value: "**\t\t:skull_crossbones: BlueCap**\n\t\t:star: BlueTwo",
      },
      {
        name: "🟢 Up for Grabs",
        value: ":gem: RedThree [1142]\n:radioactive: BlueThree [1300]",
      },
    ];
    const parsed = parseTeams(draft as any);
    expected(parsed.names.RED.join(","), "RedCap,RedTwo", "Real draft prefix");
    expected(parsed.names.BLUE.join(","), "BlueCap,BlueTwo", "ELO shortcode");
    expected(
      parsed.names.UNDECIDED.join(","),
      "RedThree,BlueThree",
      "Undecided rating tags"
    );
  }));

test("TEMP integrity: finalisation source edit requires a new preview even when meaning stays final", () =>
  withFixture(async (f) => {
    f.populate();
    f.refs.draft!.content =
      "All players have been drafted! Here is the final draft.";
    f.refs.draft!.embeds[0].footer = { text: "Blue Team: 1000 Red Team: 1000" };
    const approved = f.message(
      CHANNELS.teamPickingChat,
      [],
      "Teams have been finalised!",
      f.now - 1000
    );
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    approved.content = "Teams have been locked!";
    await c.handleButtonPress(f.button(f.getButtonId(interaction.responses)).i);
    assert(
      !GameInstance.getInstance().announced,
      "Finalisation message is part of confirmation evidence"
    );
  }));

test("TEMP integrity: season rules changing without an ID/type change reject confirmation", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    (f.state.season as any).gameLimit = 999;
    await c.handleButtonPress(f.button(f.getButtonId(interaction.responses)).i);
    assert(!GameInstance.getInstance().announced, "Season settings changed");
  }));

test("TEMP integrity: partial in-memory roster blocks recovery without an announcement", () =>
  withFixture(async (f) => {
    f.populate();
    const game = GameInstance.getInstance();
    game.teams.UNDECIDED.push({
      discordSnowflake: "999999999999999999",
    } as any);
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "unresolved"
    );
    assert(
      game.teams.UNDECIDED.length === 1,
      "Existing partial roster remains untouched"
    );
  }));

test("TEMP integrity: an unannounced game with configured settings cannot be overwritten", () =>
  withFixture(async (f) => {
    f.populate();
    const game = GameInstance.getInstance();
    game.startTime = f.startTime;
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "unresolved"
    );
    expected(
      game.startTime?.getTime(),
      f.startTime.getTime(),
      "Existing scheduling retained"
    );
  }));

test("TEMP permissions: role revoked after initial confirmation check blocks installation", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const original = f.guild.members.fetch;
    let count = 0;
    f.guild.members.fetch = async (id: string) => {
      const member = await original(id);
      count++;
      return {
        ...member,
        roles: {
          cache: { has: () => count === 1 },
        },
      };
    };
    await c.handleButtonPress(f.button(f.getButtonId(interaction.responses)).i);
    assert(
      !GameInstance.getInstance().announced,
      "Role revoked during verification must block commit"
    );
  }));

test("TEMP integrity: an early game-end signal still requires the started phase", () =>
  withFixture(async (f) => {
    f.populate();
    const later = f.startTime.getTime() + 4 * 60 * 60_000;
    f.refs.announcement!.embeds[0].fields[0].value = `<t:${Math.floor(later / 1000)}:F>`;
    f.message(CHANNELS.gameFeed, [], "The game is over", f.now - 2000);
    await reject(
      () => buildDiscordRecovery(f.guild, f.options()),
      "Choose phase 'started'"
    );
  }));

test("TEMP integrity: a delayed game-end signal is recognised for unsaved games", () =>
  withFixture(async (f) => {
    f.populate();
    const oldStart = f.now - 3 * 86_400_000;
    f.refs.announcement!.createdTimestamp = oldStart - 5 * 60_000;
    f.refs.announcement!.embeds[0].fields[0].value = `<t:${Math.floor(oldStart / 1000)}:F>`;
    f.refs.registration!.createdTimestamp = oldStart + 5 * 60_000;
    f.refs.teams!.createdTimestamp = oldStart + 6 * 60_000;
    f.refs.draft!.createdTimestamp = oldStart + 6 * 60_000;
    const ended = f.message(
      CHANNELS.gameFeed,
      [],
      "The game is over",
      f.now - 60_000
    );
    const proposal = await buildDiscordRecovery(f.guild, {
      ...f.options("started"),
      announcementLink: f.refs.announcement!.url,
    });
    expected(
      proposal.recoveredEndTime?.getTime(),
      ended.createdTimestamp,
      "Late ending timestamp"
    );
  }));

test("TEMP concurrency: recovery admission blocks new game operations while prior ones drain", () =>
  withFixture(async () => {
    const existing = GameRecoveryCoordinator.enterOperation();
    assert(existing !== null, "A normal command can enter first");
    const claim = GameRecoveryCoordinator.claimDiscordRecovery();
    assert(
      GameRecoveryCoordinator.enterOperation() === null,
      "No new commands admitted"
    );
    let acquired = false;
    void claim.then(() => {
      acquired = true;
    });
    await Promise.resolve();
    assert(!acquired, "Exclusive claim waits for the active game operation");
    existing!();
    const release = await claim;
    assert(
      GameRecoveryCoordinator.enterOperation() === null,
      "Lock remains exclusive"
    );
    release();
    const after = GameRecoveryCoordinator.enterOperation();
    assert(after !== null, "Normal game commands resume after release");
    after!();
  }));

test("TEMP concurrency: recovery lock prevents other announcements and snapshot capture", () =>
  withFixture(async () => {
    const release = await GameRecoveryCoordinator.claimDiscordRecovery();
    try {
      await reject(
        () => GameInstance.getInstance().beginConfirmedAnnouncement(),
        "recovery"
      );
      await reject(
        () => GameRecoveryCoordinator.capture(GameInstance.getInstance()),
        "recovery"
      );
      GameRecoveryCoordinator.withDiscordInstallation(() =>
        GameInstance.getInstance().beginConfirmedAnnouncement()
      );
      assert(
        GameInstance.getInstance().announced,
        "Only the exclusive installer can publish state"
      );
    } finally {
      release();
    }
  }));

test("TEMP concurrency: confirmation holds exclusive lock while verifying Discord", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command(),
      interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const other = GameRecoveryCoordinator.enterOperation();
    assert(other !== null, "Previous game operation admitted");
    let signalReached!: () => void;
    const reachedClaim = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    const originalClaim = GameRecoveryCoordinator.claimDiscordRecovery;
    GameRecoveryCoordinator.claimDiscordRecovery = (timeoutMs?: number) => {
      const claim = originalClaim.call(GameRecoveryCoordinator, timeoutMs);
      signalReached();
      return claim;
    };
    try {
      const confirm = c.handleButtonPress(
        f.button(f.getButtonId(interaction.responses)).i
      );
      await reachedClaim; // Synchronises with the claim, not an arbitrary delay.
      assert(
        GameRecoveryCoordinator.enterOperation() === null,
        "New commands are blocked"
      );
      other!();
      await confirm;
      assert(
        GameInstance.getInstance().announced,
        "Valid confirmation installs after drain"
      );
    } finally {
      GameRecoveryCoordinator.claimDiscordRecovery = originalClaim;
    }
  }));

test("TEMP command: reply failure after install cannot roll back installed state", () =>
  withFixture(async (f) => {
    f.populate();
    const c = f.command();
    const interaction = f.slash(f.options());
    await c.execute(interaction.i);
    const button = f.button(f.getButtonId(interaction.responses));
    button.i.editReply = async () => {
      throw new Error("Discord ack lost");
    };
    await c.handleButtonPress(button.i);
    assert(
      GameInstance.getInstance().announced,
      "installation retained after reply failure"
    );
  }));
