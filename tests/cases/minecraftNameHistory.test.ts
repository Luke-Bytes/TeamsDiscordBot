import { MessageFlags } from "discord.js";
import { MojangAPI } from "../../src/api/MojangAPI";
import { MinecraftNameHistoryAPI } from "../../src/api/MinecraftNameHistoryAPI";
import { mergeNameHistory } from "../../src/api/NameHistoryMerge";
import { DatabaseNameHistory } from "../../src/database/DatabaseNameHistory";
import { prismaClient } from "../../src/database/prismaClient";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { parseHistory, providerResult, retryAfterMs } from "../../src/api/NameHistoryProviders";
import { historyDate, normalizeHistoryUUID, NameHistoryResult } from "../../src/api/NameHistoryTypes";
import NameHistoryCommand from "../../src/commands/NameHistoryCommand";
import { buildNameHistoryPages } from "../../src/commands/NameHistoryPresentation";
import { test } from "../framework/test";
import { assert, assertEqual as checkEqual } from "../framework/assert";

function assertEqual<T>(actual: T, expected: T, message = "Unexpected name history result"): void {
  checkEqual(actual, expected, message);
}
import { createChatInputInteraction, FakeGuild } from "../framework/mocks";

const uuid = "a".repeat(32);
const other = "b".repeat(32);
const labyRows = [
  { name: "First_Name", changed_at: "2013-04-02", accurate: true },
  { name: "Old_Name", changed_at: "2018-01-02", accurate: true },
  { name: "Another", changed_at: "2020-01-01", accurate: false },
  { name: "OLD_NAME", changed_at: "2021-01-02", accurate: true, last_seen_at: "2022-02-02T09:00:00+00:00" },
  { name: "Current", changed_at: "2023-01-02", accurate: false },
];
const winstreakRows = { nameHistory: [
  { name: "old_name", timestamp: Date.UTC(2019, 0, 1) },
  { name: "Other", timestamp: Date.UTC(2015, 0, 1) },
  { name: "Current", timestamp: Date.UTC(2023, 0, 3) },
] };

test("name history documented Laby and Winstreak records retain distinct evidence and precision", () => {
  const laby = parseHistory("laby", uuid, labyRows);
  const winstreak = parseHistory("winstreak", uuid, winstreakRows);
  assertEqual(laby.status, "success");
  assertEqual(winstreak.status, "success");
  assertEqual(laby.observations[0].date.kind, "reported");
  assertEqual(laby.observations[1].date.precision, "day");
  assertEqual(laby.observations[2].date.kind, "firstObserved");
  assertEqual(winstreak.observations[0].date.kind, "reported");
  const merged = mergeNameHistory("Current", [laby, winstreak]);
  assertEqual(merged[0].name, "Current");
  const old = merged.find((n) => n.normalizedName === "old_name")!;
  assertEqual(old.observations.length, 3);
  assertEqual(old.variants.length, 3);
  assertEqual(old.providers.length, 2);
  assertEqual(old.bestDate.kind, "accurateChange");
  assertEqual(old.bestDate.value, "2021-01-02");
  assert(old.conflictingDates, "Conflicting or repeated dates should remain visible");
  assertEqual(old.latestObservation?.kind, "lastObserved");
  assertEqual(merged.length, 5);
});

test("name history invalid dates, malformed data, mismatches and withheld rows are handled conservatively", () => {
  assertEqual(historyDate("2020-02-30", "reported").value, null);
  assertEqual(historyDate("2099-01-01", "reported").value, null);
  assertEqual(historyDate("2020-02-29", "reported").precision, "day");
  assertEqual(normalizeHistoryUUID("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"), uuid);
  assertEqual(normalizeHistoryUUID("a-a" + uuid), undefined);
  assertEqual(parseHistory("laby", uuid, []).status, "noHistory");
  assertEqual(parseHistory("winstreak", uuid, { nameHistory: [] }).status, "noHistory");
  assertEqual(parseHistory("winstreak", uuid, { names: [] }).status, "invalidResponse");
  assertEqual(parseHistory("winstreak", uuid, { uuid: other, ...winstreakRows }).status, "uuidMismatch");
  const partial = parseHistory("laby", uuid, [...labyRows, { name: "bad name" }]);
  assert(partial.limited, "Bad rows must be disclosed");
  assertEqual(partial.observations.length, labyRows.length);
  const masked = parseHistory("laby", uuid, [{ name: "Old_Name", changed_at: null, accurate: false }]);
  const merged = mergeNameHistory("Current", [masked, parseHistory("winstreak", uuid, winstreakRows)]);
  assertEqual(merged.find((n) => n.normalizedName === "old_name")?.bestDate.kind, "withheld");
  const hidden = parseHistory("laby", uuid, [{ name: null, hidden: true }]);
  assertEqual(hidden.status, "withheld");
  assertEqual(mergeNameHistory("Current", [hidden, partial]).length, 1);
});

// Advance between fixtures so provider rate windows never leak across tests.
let offlineClockOffset = 0;

function mockHistoryFetch(handler: typeof fetch): void {
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("https://mcprofiles.me/api/player/")) {
      return json({ kind: "profile", data: { uuid: target.split("/").pop(), usernameHistory: [] } });
    }
    if (target.startsWith("https://api.crafty.gg/api/v2/players/")) {
      return json({ success: true, data: { uuid, username: "Current", usernames: [] } });
    }
    return handler(url, init);
  };
}

async function offline(run: () => Promise<void>): Promise<void> {
  const fetch = globalThis.fetch;
  const lookup = MojangAPI.lookupUsername;
  const reverse = MojangAPI.uuidToUsername;
  const database = DatabaseNameHistory.lookup;
  const keys = ["LABY_API_TOKEN", "WINSTREAK_API_KEY", "BISAI_API_KEY", "CRAFTY_API_TOKEN", "MC_NAME_HISTORY_SUPPRESSED_UUIDS"];
  const original = keys.map((key) => process.env[key]);
  const now = Date.now;
  try {
    MinecraftNameHistoryAPI.invalidate();
    for (const key of keys) delete process.env[key];
    const offset = (offlineClockOffset += 1_000_000);
    Date.now = () => now() + offset;
    MojangAPI.lookupUsername = async () => ({ status: "found", uuid });
    MojangAPI.uuidToUsername = async () => "Current";
    DatabaseNameHistory.lookup = async () => ({ history: providerResult("database", "noHistory"), playerRecords: [] });
    mockHistoryFetch(async () => { throw new Error("Unexpected credentialed provider request"); });
    await run();
  } finally {
    globalThis.fetch = fetch;
    MojangAPI.lookupUsername = lookup;
    MojangAPI.uuidToUsername = reverse;
    DatabaseNameHistory.lookup = database;
    Date.now = now;
    keys.forEach((key, i) => {
      if (original[i] === undefined) delete process.env[key];
      else process.env[key] = original[i];
    });
    MinecraftNameHistoryAPI.invalidate();
  }
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers });
}

test("name history resolves current ownership, handles reassignment and skips unconfigured providers", async () => offline(async () => {
  let requests = 0;
  mockHistoryFetch(async () => { requests++; throw new Error("Unexpected credentialed provider"); });
  assertEqual((await MinecraftNameHistoryAPI.lookup("not valid")).status, "invalid");
  MojangAPI.lookupUsername = async () => ({ status: "notFound" });
  assertEqual((await MinecraftNameHistoryAPI.lookup("Missing")).status, "notFound");
  MojangAPI.lookupUsername = async () => ({ status: "unavailable" });
  assertEqual((await MinecraftNameHistoryAPI.lookup("Current")).status, "unavailable");
  MojangAPI.lookupUsername = async (_name, fresh) => ({ status: "found", uuid: fresh ? other : uuid });
  MojangAPI.uuidToUsername = async (id) => id === uuid ? "Different" : "Current";
  const result = await MinecraftNameHistoryAPI.lookup("current");
  assertEqual(result.uuid, other);
  assertEqual(result.names[0].name, "Current");
  assertEqual(result.providers[0].status, "notConfigured");
  assertEqual(requests, 0);
  const dashed = await MinecraftNameHistoryAPI.lookupByUUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  assertEqual(dashed.uuid, other);
}));

test("name history runs all configured providers, coalesces requests and respects cache and suppression", async () => offline(async () => {
  process.env.LABY_API_TOKEN = "test-laby";
  process.env.WINSTREAK_API_KEY = "test-winstreak";
  const calls: string[] = [];
  mockHistoryFetch(async (url, init) => {
    const target = String(url);
    calls.push(target);
    assert(target.includes(uuid), "Only resolved UUID may be queried");
    assertEqual(init?.redirect, "error");
    assert(!!init?.signal, "Provider requests must be abortable");
    assertEqual(new Headers(init?.headers).get("Authorization"), target.includes("laby.net") ? "Bearer test-laby" : "Bearer test-winstreak");
    return target.includes("laby.net") ? json(labyRows) : json(winstreakRows);
  });
  const [one, two] = await Promise.all([MinecraftNameHistoryAPI.lookupByUUID(uuid), MinecraftNameHistoryAPI.lookupByUUID(uuid)]);
  assertEqual(calls.length, 2);
  assertEqual(one.names.length, two.names.length);
  const again = await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assertEqual(calls.length, 3);
  assert(!!again.providers.find((p) => p.provider === "winstreak")?.cached, "Winstreak should be cached");
  const now = Date.now();
  Date.now = () => now + 601_000;
  await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assertEqual(calls.length, 5);
  process.env.MC_NAME_HISTORY_SUPPRESSED_UUIDS = uuid;
  MinecraftNameHistoryAPI.invalidate(uuid);
  const suppressed = await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assert(suppressed.suppressed, "Opt-out suppresses all history");
  assertEqual(suppressed.names.length, 1);
  assertEqual(calls.length, 5);
}));

test("name history reports HTTP failures separately, retains current name and observes Retry-After", async () => offline(async () => {
  const time = Date.now();
  Date.now = () => time + 90_000;
  process.env.LABY_API_TOKEN = "test-laby";
  process.env.WINSTREAK_API_KEY = "test-winstreak";
  let count = 0;
  mockHistoryFetch(async (url) => {
    count++;
    return String(url).includes("laby.net") ? json({}, 429, { "Retry-After": "60" }) : json({}, 403);
  });
  const result = await MinecraftNameHistoryAPI.lookupByUUID(other);
  assertEqual(result.names.length, 1);
  assert(result.partial, "Failures must be disclosed");
  assertEqual(result.providers[0].status, "rateLimited");
  assertEqual(result.providers[1].status, "authenticationRequired");
  await MinecraftNameHistoryAPI.lookupByUUID(other);
  assertEqual(count, 2);
  Date.now = () => time + 151_000;
  mockHistoryFetch(async (url) => String(url).includes("laby.net") ? json({}, 404) : json({}, 503));
  const after = await MinecraftNameHistoryAPI.lookupByUUID(other);
  assertEqual(after.providers[0].status, "notFound");
  assertEqual(after.providers[1].status, "unavailable");
  assert(retryAfterMs("120") >= 120_000, "Retry-After seconds must be honoured");
}));

test("name history handles abort and timeout independently of a successful provider", async () => offline(async () => {
  const time = Date.now();
  Date.now = () => time + 240_000;
  process.env.LABY_API_TOKEN = "test-laby";
  process.env.WINSTREAK_API_KEY = "test-winstreak";
  let aborted = false;
  mockHistoryFetch(async (url, init) => {
    if (String(url).includes("winstreak")) return json(winstreakRows);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("Aborted"));
      }, { once: true });
    });
  });
  const result = await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assert(aborted, "Timed out fetch must actually abort");
  assertEqual(result.providers[0].status, "timeout");
  assertEqual(result.providers[1].status, "success");
  assert(result.names.some((n) => n.normalizedName === "other"), "Successful provider survives timeout");
}));

test("/name history registers, defers publicly and renders an unregistered account", async () => offline(async () => {
  const command = new NameHistoryCommand();
  assertEqual(command.data.toJSON().name, "name");
  assertEqual(command.data.toJSON().options?.[0].name, "history");
  const request = createChatInputInteraction("name-tester", {
    guild: new FakeGuild() as any, subcommand: "history", strings: { username: "Current" },
  });
  let flags: unknown;
  request.deferReply = (async (options: any) => { flags = options.flags; request.deferred = true; }) as any;
  await command.execute(request);
  assertEqual(flags, undefined);
  const edit = request.replies.find((r) => r.type === "editReply")?.payload;
  const embed = edit.embeds[0].data;
  assertEqual(embed.title, "Current");
  assertEqual(embed.description, "No previous names found.");
  assertEqual(embed.thumbnail.url, `https://mc-heads.net/avatar/${uuid}/64.png`);
  assert(!embed.footer.text.includes("Page 1/1"), "Single page needs no page number");
  assert(!embed.footer.text.includes("not configured"), "Do not show provider configuration");
  assertEqual(edit.allowedMentions.parse.length, 0);
  const invalid = createChatInputInteraction("name-tester2", { guild: new FakeGuild() as any, subcommand: "history", strings: { username: "invalid name" } });
  await command.execute(invalid);
  assertEqual(invalid.replies[0].payload.flags, MessageFlags.Ephemeral);
}));

test("/name history allows another lookup after five seconds but blocks immediate repeats", async () => {
  const originalNow = Date.now;
  const originalLookup = MinecraftNameHistoryAPI.lookup;
  let now = originalNow();
  let lookups = 0;
  const command = new NameHistoryCommand();
  const guild = new FakeGuild() as any;
  const request = (user = "cooldown-tester") => createChatInputInteraction(user, {
    guild, subcommand: "history", strings: { username: "Current" },
  });
  try {
    Date.now = () => now;
    MinecraftNameHistoryAPI.lookup = async () => {
      lookups++;
      return { status: "notFound", names: [], providers: [], suppressed: false, partial: true };
    };
    await command.execute(request());
    now += 4_999;
    const blocked = request();
    await command.execute(blocked);
    assertEqual(blocked.replies[0].payload.flags, MessageFlags.Ephemeral);
    assertEqual(blocked.replies[0].payload.content, "Please wait before requesting another history.");
    assertEqual(lookups, 1);
    await command.execute(request("another-user"));
    assertEqual(lookups, 2);
    now++;
    await command.execute(request());
    assertEqual(lookups, 3);
  } finally {
    Date.now = originalNow;
    MinecraftNameHistoryAPI.lookup = originalLookup;
  }
});

test("database name history merges UUID-linked rows, isolates player-only aliases and preserves match dates", async () => {
  const findPlayers = prismaClient.player.findMany;
  const findSignups = prismaClient.eventSignup.findMany;
  const findGames = prismaClient.gameParticipation.findMany;
  let gameQueries = 0;
  let playerQueries = 0;
  const actualLookup = DatabaseNameHistory.lookup;
  try {
    (prismaClient.player as any).findMany = async (args: any) => {
      playerQueries++;
      assert(args.where.primaryMinecraftAccount.in.includes("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), "Must match dashed UUIDs");
      assertEqual(args.where.primaryMinecraftAccount.mode, "insensitive");
      return [{ id: "player-id", primaryMinecraftAccount: uuid.toUpperCase(), latestIGN: "Stored_Name",
        minecraftAccounts: ["Legacy_Name", "legacy_name", other, "Bad Name", "Old_Name"] }];
    };
    (prismaClient.eventSignup as any).findMany = async (args: any) => {
      assertEqual(args.where.event.guildId, "guild-1");
      assertEqual(args.select.discordUserId, undefined);
      return [
        { minecraftUUID: uuid, minecraftUsername: "Event_Name" },
        { minecraftUUID: uuid, minecraftUsername: "OLD_NAME" },
        { minecraftUUID: other, minecraftUsername: "Wrong_Account" },
      ];
    };
    (prismaClient.gameParticipation as any).findMany = async (args: any) => {
      gameQueries++;
      assertEqual(args.where.playerId, "player-id");
      assertEqual(args.where.game.finished, true);
      return [
        { ignUsed: "Legacy_Name", game: { startTime: new Date("2020-05-01T12:00:00Z") } },
        { ignUsed: "legacy_name", game: { startTime: new Date("2021-05-01T12:00:00Z") } },
        { ignUsed: "UnknownIGN", game: { startTime: new Date("2021-05-01") } },
      ];
    };
    await offline(async () => {
      DatabaseNameHistory.lookup = actualLookup;
      process.env.LABY_API_TOKEN = "test";
      const now = Date.now();
      Date.now = () => now + 400_000;
      mockHistoryFetch(async () => json(labyRows));
      const ordinary = await MinecraftNameHistoryAPI.lookupByUUID(uuid, { guildId: "guild-1" });
      assertEqual(gameQueries, 0);
      assertEqual(ordinary.localPlayerNames?.length, 0);
      assert(ordinary.names.some((n) => n.name === "Event_Name"), "UUID-linked signup must appear");
      assert(ordinary.names.some((n) => n.name === "Stored_Name"), "Stored primary identity must appear");
      assert(!ordinary.names.some((n) => n.name === "Wrong_Account"), "Never accept a different UUID");
      assert(ordinary.names.find((n) => n.normalizedName === "old_name")?.providers.includes("database"), "Case-insensitive source merge");
      assertEqual(ordinary.names.find((n) => n.name === "Event_Name")?.bestDate.value, null);
      const organiser = await MinecraftNameHistoryAPI.lookupByUUID(uuid, { guildId: "guild-1", includePlayerRecords: true });
      assertEqual(gameQueries, 1);
      assertEqual(organiser.localPlayerNames?.length, 1);
      assertEqual(organiser.localPlayerNames?.[0].normalizedName, "legacy_name");
      assertEqual(organiser.localPlayerNames?.[0].bestDate.value, "2021-05-01T12:00:00.000Z");
      assertEqual(organiser.localPlayerNames?.[0].earliest?.value, "2020-05-01T12:00:00.000Z");
      assertEqual(organiser.names.length, ordinary.names.length);
      assertEqual(playerQueries, 2);
      const page = buildNameHistoryPages(organiser).pages[0].data;
      assert(page.footer?.text.includes("Friendly Wars") && page.footer.text.includes("recorded associations"), "Source and identity caveat must be shown");
      assert(!page.description?.toLowerCase().includes("legacy"), "No organiser aliases in public result");
      assertEqual(page.description, buildNameHistoryPages(ordinary).pages[0].data.description);
      process.env.MC_NAME_HISTORY_SUPPRESSED_UUIDS = uuid;
      const suppressed = await MinecraftNameHistoryAPI.lookupByUUID(uuid, { guildId: "guild-1", includePlayerRecords: true });
      assertEqual(suppressed.names.length, 1);
      assertEqual(suppressed.localPlayerNames?.length, 0);
      assertEqual(playerQueries, 2);
    });
  } finally {
    (prismaClient.player as any).findMany = findPlayers;
    (prismaClient.eventSignup as any).findMany = findSignups;
    (prismaClient.gameParticipation as any).findMany = findGames;
  }
});

test("database name history handles missing and ambiguous players, independent failures, and guild scope", async () => {
  const findPlayers = prismaClient.player.findMany;
  const findSignups = prismaClient.eventSignup.findMany;
  const findGames = prismaClient.gameParticipation.findMany;
  try {
    (prismaClient.player as any).findMany = async () => [];
    (prismaClient.eventSignup as any).findMany = async () => [{ minecraftUUID: uuid, minecraftUsername: "Event_Name" }];
    (prismaClient.gameParticipation as any).findMany = async () => { throw new Error("Must not query games"); };
    const unregistered = await DatabaseNameHistory.lookup(uuid, { guildId: "guild-1" });
    assertEqual(unregistered.history.status, "success");
    assertEqual(unregistered.history.observations.length, 1);
    const noGuild = await DatabaseNameHistory.lookup(uuid, {});
    assertEqual(noGuild.history.status, "noHistory");
    (prismaClient.player as any).findMany = async () => [{ primaryMinecraftAccount: uuid, latestIGN: "One" }, { primaryMinecraftAccount: uuid, latestIGN: "Two" }];
    const ambiguous = await DatabaseNameHistory.lookup(uuid, { guildId: "guild-1", includePlayerRecords: true });
    assert(ambiguous.history.limited, "Ambiguous ownership must be disclosed");
    assertEqual(ambiguous.history.observations.length, 1);
    assertEqual(ambiguous.playerRecords.length, 0);
    (prismaClient.player as any).findMany = async () => { throw new Error("Database unavailable"); };
    const partial = await DatabaseNameHistory.lookup(uuid, { guildId: "guild-1" });
    assertEqual(partial.history.status, "success");
    assert(partial.history.limited, "Partial database failure must be disclosed");
    (prismaClient.eventSignup as any).findMany = async () => { throw new Error("Database unavailable"); };
    assertEqual((await DatabaseNameHistory.lookup(uuid, { guildId: "guild-1" })).history.status, "unavailable");
    await offline(async () => {
      DatabaseNameHistory.lookup = async () => { throw new Error("Database unavailable"); };
      const result = await MinecraftNameHistoryAPI.lookupByUUID(uuid);
      assertEqual(result.status, "found");
      assertEqual(result.providers.find((p) => p.provider === "database")?.status, "unavailable");
      assertEqual(result.names.length, 1);
    });
  } finally {
    (prismaClient.player as any).findMany = findPlayers;
    (prismaClient.eventSignup as any).findMany = findSignups;
    (prismaClient.gameParticipation as any).findMany = findGames;
  }
});

test("/name history never requests private player-linked records, even for organisers", async () => offline(async () => {
  const permission = PermissionsUtil.hasRole;
  const scopes: boolean[] = [];
  try {
    DatabaseNameHistory.lookup = async (_uuid, scope) => {
      scopes.push(!!scope.includePlayerRecords);
      return { history: providerResult("database", "noHistory"), playerRecords: [] };
    };
    const command = new NameHistoryCommand();
    for (const organiser of [false, true]) {
      PermissionsUtil.hasRole = () => organiser;
      const request = createChatInputInteraction("scope-" + organiser, {
        guild: new FakeGuild() as any, subcommand: "history", strings: { username: "Current" },
      });
      await command.execute(request);
    }
    assertEqual(scopes.join(","), "false,false");
  } finally { PermissionsUtil.hasRole = permission; }
}));

const mcProfile = {
  kind: "profile",
  data: { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", username: "Current",
    verifiedAt: 1700000000000,
    usernameHistory: [{ username: "Old_Name", observedAt: "2018-02-03T04:05:06Z" }] },
  meta: { cacheState: "stale" },
};
const bisai = {
  uuid, total: 3, limit: 500, offset: 0,
  names: [
    { name: "Old_Name", occurrence: 0, first_seen: null, last_seen: "2018-02-03T00:00:00Z" },
    { name: "Old_Name", occurrence: 1, first_seen: "2020-01-01T00:00:00Z", last_seen: "2021-01-01T00:00:00Z" },
    { name: "Current", occurrence: 0, first_seen: "2021-01-01T00:00:00Z", last_seen: null },
  ],
};

test("name history MCProfiles checks UUID, archives, privacy and observation dates", () => {
  const result = parseHistory("mcprofiles", uuid, { ...mcProfile, kind: "archiveFallback" });
  assertEqual(result.status, "success");
  assert(result.archived && result.stale && result.cached, "Archive and stale evidence disclosed");
  assertEqual(result.observations[0].date.kind, "lastObserved");
  assertEqual(result.observations[0].date.value, "2018-02-03T04:05:06.000Z");
  assertEqual(parseHistory("mcprofiles", other, mcProfile).status, "uuidMismatch");
  assertEqual(parseHistory("mcprofiles", uuid, { ...mcProfile, kind: "historicalMatches" }).status, "invalidResponse");
  assertEqual(parseHistory("mcprofiles", uuid, { kind: "notFound" }).status, "notFound");
  assertEqual(parseHistory("mcprofiles", uuid, { ...mcProfile, data: { ...mcProfile.data, private: true } }).status, "withheld");
  assertEqual(parseHistory("mcprofiles", uuid, { ...mcProfile, data: { ...mcProfile.data, usernameHistory: [] } }).status, "noHistory");
});

test("name history Bisai validates paging and retains separate observed usage periods", () => {
  const result = parseHistory("bisai", uuid, bisai);
  assertEqual(result.status, "success");
  assertEqual(result.observations[0].date.kind, "unknown");
  assertEqual(result.observations[1].date.kind, "firstObserved");
  assertEqual(result.observations[1].occurrence, 1);
  assertEqual(result.observations[2].observedCurrent, true);
  assertEqual(mergeNameHistory("Current", [result])[1].observations.length, 2);
  assertEqual(parseHistory("bisai", uuid, { ...bisai, total: 510 }).limited, true);
  assertEqual(parseHistory("bisai", other, bisai).status, "uuidMismatch");
  assertEqual(parseHistory("bisai", uuid, { ...bisai, offset: 1 }).status, "invalidResponse");
  assertEqual(parseHistory("bisai", uuid, { ...bisai, total: 0, names: [] }).status, "noHistory");
});

const craftyProfile = {
  success: true,
  data: {
    uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    username: "Current",
    deleted: false,
    usernames: [
      { username: "Old_Name", available: true, changed_at: "2019-02-03T04:05:06Z", hidden: false },
      { username: "Crafty_Only", available: false, changed_at: "2020-04-05T00:00:00Z", hidden: false },
      { username: "Current", changed_at: "2021-01-01T00:00:00Z", hidden: false },
    ],
    socials: [{ handle: "not-history" }],
  },
};

test("Crafty validates UUID and visible history, discards unrelated profile data", () => {
  const result = parseHistory("crafty", uuid, craftyProfile);
  assertEqual(result.status, "success");
  assertEqual(result.observations.length, 3);
  assertEqual(result.observations[0].date.kind, "reported");
  assertEqual(result.observations[0].date.value, "2019-02-03T04:05:06.000Z");
  assertEqual(parseHistory("crafty", other, craftyProfile).status, "uuidMismatch");
  assertEqual(parseHistory("crafty", uuid, { success: false, message: "error" }).status, "invalidResponse");
  const profile = (usernames: unknown[]) => ({ ...craftyProfile, data: { ...craftyProfile.data, usernames } });
  assertEqual(parseHistory("crafty", uuid, profile([])).status, "noHistory");
  assertEqual(parseHistory("crafty", uuid, profile([{ username: "Old_Name", changed_at: null }])).status, "invalidResponse");
  assertEqual(parseHistory("crafty", uuid, profile([{ username: "Old_Name", changed_at: null, hidden: false }])).observations[0].date.kind, "unknown");
  const hidden = parseHistory("crafty", uuid, profile([...craftyProfile.data.usernames, { username: "Hidden", hidden: true }]));
  assertEqual(hidden.status, "withheld");
  assertEqual(hidden.observations.length, 0);
  assertEqual(mergeNameHistory("Current", [hidden, parseHistory("bisai", uuid, bisai)]).length, 1);
  assertEqual(parseHistory("crafty", uuid, { ...craftyProfile, data: { ...craftyProfile.data, deleted: true } }).status, "withheld");
  assertEqual(parseHistory("crafty", uuid, profile(Array.from({ length: 501 }, () => craftyProfile.data.usernames[0]))).limited, true);
  const overflowHidden = profile([...Array.from({ length: 500 }, () => craftyProfile.data.usernames[0]), { hidden: true }]);
  assertEqual(parseHistory("crafty", uuid, overflowHidden).status, "withheld");
});

test("Crafty optional token, canonical username lookup, cache and Retry-After", async () => offline(async () => {
  process.env.CRAFTY_API_TOKEN = "test-crafty";
  const calls: string[] = [];
  let status = 200;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const headers = new Headers(init?.headers);
    if (target.startsWith("https://mcprofiles.me/")) {
      assert(!headers.has("Authorization"), "Crafty credential must not leak");
      return json(mcProfile);
    }
    assertEqual(target, "https://api.crafty.gg/api/v2/players/Current");
    assertEqual(headers.get("Authorization"), "Bearer test-crafty");
    assertEqual(init?.redirect, "error");
    assert(!!init?.signal, "Crafty must be abortable");
    calls.push(target);
    return status === 200 ? json(craftyProfile) : json({}, status, { "Retry-After": "60" });
  };
  const [one, two] = await Promise.all([MinecraftNameHistoryAPI.lookup("current"), MinecraftNameHistoryAPI.lookupByUUID(uuid)]);
  assertEqual(calls.length, 1);
  assertEqual(one.names.length, two.names.length);
  assert(one.names.some((n) => n.name === "Crafty_Only"), "Crafty-only name should merge");
  assert(buildNameHistoryPages(one).pages[0].data.footer?.text.includes("Crafty"), "Attribute Crafty in public footer");
  const again = await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assertEqual(again.providers.find((p) => p.provider === "crafty")?.cached, true);
  assertEqual(calls.length, 1);
  MinecraftNameHistoryAPI.invalidate(uuid);
  status = 429;
  const limited = await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assertEqual(limited.providers.find((p) => p.provider === "crafty")?.status, "rateLimited");
  await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assertEqual(calls.length, 2);
  const now = Date.now();
  Date.now = () => now + 61_000;
  status = 200;
  await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assertEqual(calls.length, 3);
}));

test("name history default public providers and keyed Bisai isolate credentials", async () => offline(async () => {
  process.env.LABY_API_TOKEN = "";
  process.env.WINSTREAK_API_KEY = "   ";
  process.env.BISAI_API_KEY = "   ";
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push(target);
    const headers = new Headers(init?.headers);
    assert(!headers.has("Authorization"), "No unrelated bearer credentials");
    if (target.includes("mcprofiles.me")) {
      assert(!headers.has("X-API-Key"), "No Bisai key on MCProfiles");
      return json(mcProfile);
    }
    if (target.startsWith("https://api.crafty.gg/")) {
      assertEqual(target, "https://api.crafty.gg/api/v2/players/Current");
      assert(!headers.has("X-API-Key"), "No Bisai key on Crafty");
      return json(craftyProfile);
    }
    assertEqual(headers.get("X-API-Key"), "test-bisai");
    assert(target.includes("?limit=500"), "Bounded page");
    return json(bisai);
  };
  const initial = await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assertEqual(initial.providers[0].status, "notConfigured");
  assertEqual(initial.providers[1].status, "notConfigured");
  assertEqual(initial.providers[2].status, "success");
  assertEqual(initial.providers[3].status, "notConfigured");
  assertEqual(initial.providers[4].status, "success");
  assertEqual(calls.length, 2);
  process.env.BISAI_API_KEY = "test-bisai";
  const result = await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assertEqual(result.providers[3].status, "success");
  assertEqual(calls.length, 3);
  assertEqual(result.names.find((n) => n.normalizedName === "old_name")?.providers.length, 3);
  delete process.env.BISAI_API_KEY;
  const removed = await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assertEqual(removed.providers[3].status, "notConfigured");
  assertEqual(calls.length, 3);
  process.env.MC_NAME_HISTORY_SUPPRESSED_UUIDS = uuid;
  const suppressed = await MinecraftNameHistoryAPI.lookupByUUID(uuid);
  assert(suppressed.suppressed, "Suppression also covers the public provider");
  assertEqual(suppressed.names.length, 1);
  assertEqual(calls.length, 3);
}));

test("name history pages fit embed limits and include an explicit overflow attachment", () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ name: "Past_Name_" + i, changed_at: "2020-02-01", accurate: false }));
  const result: NameHistoryResult = {
    status: "found", uuid, currentUsername: "Current",
    names: mergeNameHistory("Current", [parseHistory("laby", uuid, rows)]),
    providers: [], suppressed: false, partial: true,
  };
  const { pages, overflow } = buildNameHistoryPages(result);
  assert(pages.length <= 4, "Bounded public messages");
  assert(pages.every((p) => p.length <= 6000 && (p.data.description?.length ?? 0) <= 4096), "Discord limits");
  assert(!!overflow?.toString().includes("Past\\_Name\\_499"), "Overflow should include every escaped name");
  assert(!overflow?.toString().includes(uuid), "No UUID in public attachment");
  assert(pages.every((p) => p.data.title === "Current" && !p.data.description?.includes(uuid)), "No UUID or redundant title in public pages");
  assert(pages.every((p) => p.data.footer?.text.includes("Sources: Laby")), "Attribute once per page");
  assert(pages.every((p) => !p.data.description?.includes("Sources:")), "No repeated source per name");
});
