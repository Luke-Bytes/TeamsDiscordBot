import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { createChatInputInteraction, FakeGuild, FakeGuildMember } from "../framework/mocks";
import { MojangAPI } from "../../src/api/MojangAPI";
import { GameInstance } from "../../src/database/GameInstance";
import { prismaClient } from "../../src/database/prismaClient";
import { RegistrationIdentity } from "../../src/database/RegistrationIdentity";
import { EventService } from "../../src/logic/EventService";
import RegisterCommand from "../../src/commands/RegisterCommand";
import MassRegisterCommand from "../../src/commands/MassRegisterCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import { GuildMembership } from "../../src/logic/GuildMembership";
import { ConfigManager } from "../../src/ConfigManager";
import { PrismaUtils } from "../../src/util/PrismaUtils";

const uuid = "ab".repeat(16);
const otherUUID = "cd".repeat(16);
const realLookup = MojangAPI.lookupUsername;
const realReverse = MojangAPI.uuidToUsername;

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}
const response = (id: string, name = "CurrentName") =>
  ({ ok: true, status: 200, json: async () => ({ id, name }) }) as Response;

test("ordinary Mojang lookups coalesce but fresh identity work supersedes older cache fills", async () => {
  const original = globalThis.fetch;
  const old = gate();
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      if (++calls === 1) {
        await old.wait;
        return response(uuid);
      }
      return response(otherUUID);
    }) as typeof fetch;
    const first = realLookup.call(MojangAPI, "CoalesceVerify");
    const joined = realLookup.call(MojangAPI, "coalesceverify");
    assertEqual(calls, 1, "One ordinary request for identical names");
    const fresh = await realLookup.call(MojangAPI, "CoalesceVerify", true);
    assert(fresh.status === "found" && fresh.uuid === otherUUID, "Fresh request does not join older work");
    assertEqual(calls, 2, "Fresh request performed a new HTTP lookup");
    old.release();
    for (const result of await Promise.all([first, joined]))
      assert(result.status === "found" && result.uuid === uuid, "Original callers receive their own result");
    const cached = await realLookup.call(MojangAPI, "CoalesceVerify");
    assert(cached.status === "found" && cached.uuid === otherUUID, "Older result cannot overwrite newer verified cache");
    assertEqual(calls, 2, "New successful cache entry reused");
  } finally {
    old.release();
    globalThis.fetch = original;
  }
});

test("event identity mutations bypass older coalesced username lookups", async () => {
  const original = globalThis.fetch;
  const old = gate();
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      if (++calls === 1) {
        await old.wait;
        return response(uuid);
      }
      return response(otherUUID);
    }) as typeof fetch;
    const earlier = realLookup.call(MojangAPI, "EventReassigned");
    const service = new EventService({ player: {
      findUnique: async () => null,
      findFirst: async () => null,
    }} as any);
    const identity = await service.identity("new-event-member", "EventReassigned");
    assertEqual(identity.uuid, otherUUID, "Event claim resolves current UUID, not older in-flight work");
    assertEqual(calls, 2, "Mutation launches a fresh request");
    old.release();
    await earlier;
    const cached = await realLookup.call(MojangAPI, "EventReassigned");
    assert(cached.status === "found" && cached.uuid === otherUUID, "Older result cannot replace fresh evidence");
  } finally {
    old.release();
    globalThis.fetch = original;
  }
});

test("profile requests coalesce only for ordinary reads and failed responses are disposed", async () => {
  const original = globalThis.fetch;
  const old = gate();
  let calls = 0;
  let disposed = 0;
  try {
    globalThis.fetch = (async () => {
      if (++calls === 1) {
        await old.wait;
        return response(uuid, "OldName");
      }
      if (calls === 2) return {
        ok: false, status: 429, headers: { get: () => "0" },
        body: { cancel: async () => { disposed++; } },
      };
      return response(uuid, "CurrentName");
    }) as typeof fetch;
    const first = realReverse.call(MojangAPI, uuid);
    const joined = realReverse.call(MojangAPI, uuid.toUpperCase());
    assertEqual(calls, 1, "Ordinary reverse lookups share in-flight work");
    assertEqual(await realReverse.call(MojangAPI, uuid, true), "CurrentName", "Strict verification starts separate work");
    assertEqual(calls, 3, "Strict request has its own bounded retry");
    assertEqual(disposed, 1, "Retry response body was cancelled");
    old.release();
    assertEqual(await first, "OldName", "First caller resolved");
    assertEqual(await joined, "OldName", "Joined caller resolved");
    assertEqual(await realReverse.call(MojangAPI, uuid), "CurrentName", "No persistent reverse cache");
    assertEqual(calls, 4, "Completed profile requests are not cached");
  } finally {
    old.release();
    globalThis.fetch = original;
  }
});

test("Mojang positive cache evicts incrementally and does not cache provider failures", async () => {
  const original = globalThis.fetch;
  const cache = (MojangAPI as any).successfulNames as Map<string, { id: string; until: number }>;
  const previousCache = new Map(cache);
  let calls = 0;
  let available = true;
  try {
    cache.clear();
    for (let i = 0; i < 500; i++) cache.set("evict" + i, { id: uuid, until: Date.now() + 60_000 });
    globalThis.fetch = (async () => {
      calls++;
      return available ? response(otherUUID) : { ok: false, status: 403, body: { cancel: async () => {} } };
    }) as typeof fetch;
    await realLookup.call(MojangAPI, "NewCacheEntry");
    assertEqual(cache.size, 500, "Cache capacity remains bounded");
    assert(!cache.has("evict0") && cache.has("evict499"), "Only the oldest live entry is evicted");
    cache.set("expiredname", { id: uuid, until: Date.now() - 1 });
    const expired = await realLookup.call(MojangAPI, "ExpiredName");
    assert(expired.status === "found" && expired.uuid === otherUUID, "Expired cache hit is refreshed");
    available = false;
    const unavailable = await realLookup.call(MojangAPI, "NoNegativeCache");
    assertEqual(unavailable.status, "unavailable", "Provider outage is not account absence");
    available = true;
    const recovered = await realLookup.call(MojangAPI, "NoNegativeCache");
    assertEqual(recovered.status, "found", "Outage does not negatively cache future lookup");
    assertEqual(calls, 5, "Two outage provider calls and three successful requests");
  } finally {
    cache.clear();
    for (const entry of previousCache) cache.set(...entry);
    globalThis.fetch = original;
  }
});

test("registration preparation reduces calls and protects ownership, moderation, roster and nickname preferences", async () => {
  const game = GameInstance.getInstance();
  const priorTeam = TeamCommand.instance;
  const originalAdd = game.addPlayerByDiscordId;
  const originalHook = game.scenarios.onRegistrationChanged;
  const originalLookup = prismaClient.player.byDiscordSnowflake;
  const originalFindFirst = prismaClient.player.findFirst;
  const originalCreate = prismaClient.player.create;
  const originalUpdate = prismaClient.player.update;
  const originalStats = (prismaClient as any).playerStats;
  const originalSeason = (prismaClient as any).season;
  const originalProfile = (prismaClient as any).profile;
  const originalPunishment = (prismaClient as any).playerPunishment;
  const originalExpiry = PrismaUtils.updatePunishmentsForExpiry;
  const originalForward = MojangAPI.usernameToUUID;
  const originalReverse = MojangAPI.uuidToUsername;
  const rows = new Map<string, any>();
  const copy = (row: any) => row ? { ...row, minecraftAccounts: [...row.minecraftAccounts] } : null;
  const record = (id: string, primary: string | null = uuid, name: string | null = "CurrentName") =>
    ({ id: "db-" + id, discordSnowflake: id, primaryMinecraftAccount: primary, latestIGN: name, minecraftAccounts: name ? [name] : [] });
  let reads = 0, creates = 0, writes = 0, forwards = 0, reverses = 0, profiles = 0, hooks = 0;
  let activeBan = false, optOut = false, current: string | null = "CurrentName", forward: string | null = uuid;
  let changeBeforeWrite = false, replaceDuringMembership = false, changeDuringStats = false;
  let renameDuringMembership = false, banDuringMembership = false, failFirstReverse = false, failHook = false, failStats = false;
  let statsMissing = false, statsCreates = 0;
  let strict = false;
  const guild = new FakeGuild() as any;
  const team = new TeamCommand();
  const command = new RegisterCommand(team);
  const rawFetch = guild.members.fetch;
  let forced = 0;
  guild.members.fetch = async (input: any) => {
    if (typeof input === "object") {
      assert(input.force === true, "Membership is force fetched");
      if (++forced === 2) {
        if (replaceDuringMembership) {
          game.reset();
          game.announced = true;
        }
        if (renameDuringMembership) current = "NewName";
        if (banDuringMembership) activeBan = true;
      }
    }
    return rawFetch(input);
  };
  const reset = () => {
    game.reset();
    game.announced = true;
    rows.clear();
    reads = creates = writes = forwards = reverses = profiles = hooks = forced = 0;
    activeBan = optOut = changeBeforeWrite = replaceDuringMembership = changeDuringStats = strict = false;
    renameDuringMembership = banDuringMembership = failFirstReverse = failHook = failStats = statsMissing = false;
    statsCreates = 0;
    current = "CurrentName";
    forward = uuid;
  };
  const run = async (id: string, name?: string) => {
    if (!guild.members.cache.get(id)) guild.addMember(new FakeGuildMember(id));
    const interaction = createChatInputInteraction(id, {
      guild, channelId: ConfigManager.getConfig().channels.registration,
      strings: name === undefined ? {} : { ingamename: name },
    });
    await command.execute(interaction);
    return String(interaction.replies.find((item) => item.type === "editReply")?.payload?.content);
  };
  try {
    game.addPlayerByDiscordId = GameInstance.prototype.addPlayerByDiscordId;
    game.scenarios.onRegistrationChanged = async () => { hooks++; if (failHook) throw new Error("Injected scenario failure"); };
    (prismaClient as any).player.byDiscordSnowflake = async (id: string) => { reads++; return copy(rows.get(id)); };
    (prismaClient as any).player.findFirst = async ({ where }: any) => copy([...rows.values()].find((row) => {
      if (where.NOT) {
        return row.discordSnowflake !== where.NOT.discordSnowflake &&
          (row.primaryMinecraftAccount?.toLowerCase() === where.OR[0].primaryMinecraftAccount.equals.toLowerCase() ||
            row.minecraftAccounts.some((account: string) => where.OR[1].minecraftAccounts.hasSome.includes(account)));
      }
      return row.latestIGN === where.latestIGN;
    }));
    (prismaClient as any).player.create = async ({ data }: any) => {
      creates++;
      const row = record(data.discordSnowflake, null, null);
      rows.set(data.discordSnowflake, row);
      return copy(row);
    };
    (prismaClient as any).player.update = async ({ where, data }: any) => {
      writes++;
      const row = [...rows.values()].find((item) => item.id === where.id);
      if (changeBeforeWrite) {
        row.primaryMinecraftAccount = otherUUID;
        row.latestIGN = "OrganiserChange";
      }
      const matches = (condition: any): boolean => {
        if (condition.OR) return condition.OR.some(matches);
        return Object.entries(condition).every(([key, value]: [string, any]) =>
          value?.isSet === false ? row[key] === undefined :
          value && "equals" in Object(value) ? JSON.stringify(row[key]) === JSON.stringify(value.equals) :
          row[key] === value);
      };
      assert(Array.isArray(where.AND), "Identity mutation must use conditional predicates");
      if (!where.AND.every(matches)) throw Object.assign(new Error("Identity changed"), { code: "P2025" });
      Object.assign(row, data);
      return copy(row);
    };
    (prismaClient as any).season = { findFirst: async () => ({ id: "active-season" }) };
    (prismaClient as any).playerStats = { findUnique: async ({ where }: any) => {
      assertEqual(where.playerId_seasonId.seasonId, "active-season", "Current season used for statistics");
      assert([...rows.values()].some((row) => row.id === where.playerId_seasonId.playerId), "Stats associated with current player");
      if (changeDuringStats) rows.get("changed-stats").primaryMinecraftAccount = otherUUID;
      return statsMissing ? null : { elo: 1450 };
    }, create: async ({ data }: any) => {
      statsCreates++;
      if (failStats) throw new Error("Injected statistics creation failure");
      statsMissing = false;
      return { ...data };
    }};
    (prismaClient as any).profile = { findUnique: async ({ where }: any) => {
      profiles++;
      assert([...rows.values()].some((row) => row.id === where.playerId), "Nickname preference uses committed player ID");
      return { autoNickname: !optOut };
    }};
    (prismaClient as any).playerPunishment = {
      findFirst: async () => activeBan ? { punishmentExpiry: new Date(Date.now() + 60_000) } : null,
    };
    PrismaUtils.updatePunishmentsForExpiry = async () => 0;
    MojangAPI.usernameToUUID = async (_name, fresh) => {
      forwards++;
      assert(fresh === true, "Explicit identity lookup must bypass cache");
      return forward;
    };
    MojangAPI.uuidToUsername = async (_uuid, verify) => {
      reverses++;
      strict = verify === true;
      // Only the implicit initial lookup may run before the roster lock.
      if (forced === 1) await team.runRosterOperation(async () => {});
      if (failFirstReverse && reverses === 1) return null;
      return current;
    };

    reset();
    rows.set("returning", record("returning"));
    assert(/successfully registered/.test(await run("returning")), "Returning player registers implicitly");
    assertEqual(reads, 2, "Only initial and commit player reads; nickname reuses ID");
    assertEqual(writes, 0, "Unchanged identity causes zero writes");
    assertEqual(reverses, 2, "Implicit registration retains initial and commit-time verification");
    assertEqual(forwards, 0, "Stored UUID needs no forward lookup");
    assertEqual(profiles, 1, "Current nickname preference is always read");
    assert(strict && hooks === 1 && forced === 2, "Strict identity, scenario hook and both membership checks preserved");

    reset();
    rows.set("rename", record("rename", uuid, "OldName"));
    optOut = true;
    assert(/successfully registered/.test(await run("rename", "CurrentName")), "Renamed account registers explicitly");
    assertEqual(forwards, 1, "Exactly one forward lookup");
    assertEqual(reverses, 1, "Exactly one reverse lookup");
    assertEqual(writes, 1, "Name history and latest IGN share one conditional write");
    assertEqual(rows.get("rename").minecraftAccounts.join(","), "OldName,CurrentName", "History preserved");
    assertEqual(guild.members.cache.get("rename").nickname, null, "Fresh opt-out honoured");

    reset();
    assert(/successfully registered/.test(await run("new", "CurrentName")), "New verified player registers");
    assertEqual(creates, 1, "One profile created");
    assertEqual(writes, 1, "Primary account, history and name combined");
    assertEqual(reads, 2, "New registration avoids redundant player lookup");
    assertEqual(game.getPlayers()[0].elo, 1450, "Correct seasonal Elo");

    reset();
    forward = null; current = null;
    assert(!/successfully registered/.test(await run("unverified", "UnknownName")), "New unverified identity is rejected");
    assertEqual(creates + writes + reverses, 0, "No profile, write or reverse lookup on failed forward verification");

    reset();
    rows.set("outage", record("outage"));
    forward = null; current = null;
    assert(/successfully registered/.test(await run("outage", "CurrentName")), "Known identity survives provider outage");
    assertEqual(writes, 0, "Stored outage fallback makes no unnecessary write");

    reset();
    rows.set("banned", record("banned"));
    activeBan = true;
    assert(/currently banned/.test(await run("banned", "CurrentName")), "Punishment enforced");
    assertEqual(forwards + reverses + writes, 0, "Ban rejected before external calls and writes");

    reset();
    rows.set("owner", record("owner"));
    rows.set("duplicate", record("duplicate", uuid.toUpperCase()));
    const results = await Promise.all([run("owner"), run("duplicate")]);
    assertEqual(game.getPlayers().length, 1, "Concurrent registrations cannot duplicate UUID even across casing");
    assertEqual(results.filter((result) => /successfully registered/.test(result)).length, 1, "Only one success");

    reset();
    rows.set("changed-stats", record("changed-stats"));
    changeDuringStats = true;
    assert(!/successfully registered/.test(await run("changed-stats")), "No-op identity re-read follows season statistics lookup");
    assertEqual(game.getPlayers().length + writes, 0, "Changed identity does not reach roster");

    reset();
    rows.set("legacy-empty", record("legacy-empty", "", null));
    assert(/successfully registered/.test(await run("legacy-empty", "CurrentName")), "Blank legacy account is assigned only a verified UUID");
    assertEqual(rows.get("legacy-empty").primaryMinecraftAccount, uuid, "Verified UUID persisted");

    reset();
    rows.set("mass", record("mass"));
    const organiser = guild.addMember(new FakeGuildMember("mass-organiser", [ConfigManager.getConfig().roles.organiserRole]));
    guild.addMember(new FakeGuildMember("mass"));
    const mass = createChatInputInteraction(organiser.id, {
      guild, member: organiser, strings: { playerlist: "CurrentName" },
    });
    await new MassRegisterCommand().execute(mass);
    assert(mass.replies.some((reply) => reply.type === "editReply" && String(reply.payload).includes("Registered (1)")), "Known-profile mass registration succeeds");
    assertEqual(reads, 1, "Mass registration reuses its initial known profile and re-reads once at commit");
    assertEqual(reverses, 1, "Mass registration resolves name once at commit");
    assertEqual(forced, 2, "Mass registration revalidates Discord membership after preparation");
    assertEqual(writes + forwards + profiles, 0, "Known profile is not rewritten and mass nickname behavior is unchanged");

    reset();
    rows.set("changed", record("changed", uuid, "OldName"));
    changeBeforeWrite = true;
    assert(/stored Minecraft identity changed/.test(await run("changed", "CurrentName")), "Conditional write reports concurrent identity change");
    assertEqual(rows.get("changed").latestIGN, "OrganiserChange", "Concurrent change is not overwritten");
    assertEqual(game.getPlayers().length, 0, "Rejected identity cannot reach roster");

    reset();
    rows.set("stale", record("stale", uuid, "OldName"));
    current = "OldName";
    renameDuringMembership = true;
    assert(/successfully registered as `NewName`/.test(await run("stale", "OldName")), "Commit resolves a rename after preparation");
    assertEqual(rows.get("stale").latestIGN, "NewName", "Fresh name persisted");

    reset();
    renameDuringMembership = true;
    assert(/username changed during verification/.test(await run("new-stale", "CurrentName")), "A new account cannot claim a UUID whose current name contradicts the request");
    assertEqual(creates + writes + game.getPlayers().length, 0, "Reassigned name cannot create a player or roster entry");

    reset();
    rows.set("recover", record("recover", uuid, "OldName"));
    current = "NewName";
    failFirstReverse = true;
    assert(/successfully registered as `NewName`/.test(await run("recover")), "Implicit registration recovers after initial reverse failure");
    assertEqual(reverses, 2, "Recovery retries at commit");

    reset();
    rows.set("banned-late", record("banned-late"));
    banDuringMembership = true;
    assert(/currently banned/.test(await run("banned-late")), "Ban applied before commit is enforced");
    assertEqual(game.getPlayers().length, 0, "Late ban cannot enter roster");

    reset();
    rows.set("duplicate-banned", record("duplicate-banned"));
    assert(/successfully registered/.test(await run("duplicate-banned")), "Initial signup succeeds");
    activeBan = true;
    assert(/currently banned/.test(await run("duplicate-banned")), "Punishment response takes precedence over duplicate registration");
    assertEqual(game.getPlayers().length, 1, "Duplicate registration never inserts again");

    reset();
    rows.set("mass", record("mass"));
    activeBan = true;
    const bannedMass = createChatInputInteraction(organiser.id, {guild, member: organiser, strings: {playerlist: "CurrentName"}});
    await new MassRegisterCommand().execute(bannedMass);
    assert(bannedMass.replies.some((reply) => reply.type === "editReply" && String(reply.payload).includes("currently banned")), "Mass registration enforces the same ban");
    assertEqual(game.getPlayers().length, 0, "Banned mass registration cannot enter roster");

    reset();
    rows.set("absent-owner", record("absent-owner", uuid.toUpperCase()));
    assert(/already linked/.test(await run("claimant", "CurrentName")), "Persisted ownership prevents another player claiming an absent player's UUID");
    assertEqual(creates + writes + game.getPlayers().length, 0, "Rejected claim leaves no player or roster entry");

    // Hold the game writer after its ownership read. Event preparation may
    // finish concurrently, but its transactional ownership read must wait.
    reset();
    const claimRead = gate(), releaseClaim = gate(), eventPrepared = gate();
    const findOwner = prismaClient.player.findFirst;
    let eventTransactions = 0;
    let eventWrites = 0;
    let registering: Promise<string> | undefined;
    let signing: Promise<string> | undefined;
    const eventDb: any = {
      player: {
        findUnique: async ({ where }: any) => copy(rows.get(where.discordSnowflake)),
        findFirst: async (args: any) => {
          const owner = await findOwner(args);
          if (!eventTransactions) eventPrepared.release();
          return owner;
        },
        upsert: async ({ create }: any) => {
          eventWrites++;
          const row = { ...record(create.discordSnowflake), ...create };
          rows.set(create.discordSnowflake, row);
          return copy(row);
        },
      },
      standaloneEvent: {
        findFirst: async () => ({
          id: "cup", guildId: "guild", state: "OPEN", revision: 0,
          formRevision: 0, questions: [], capacity: null, signupDeadline: null,
        }),
        updateMany: async () => ({ count: 1 }),
      },
      eventGuildState: { findUnique: async () => ({ currentEventId: "cup" }) },
      eventSignup: {
        findMany: async () => [], findUnique: async () => null, count: async () => 0,
        upsert: async ({ create }: any) => create,
      },
      $transaction: async (work: any) => { eventTransactions++; return work(eventDb); },
    };
    try {
      (prismaClient.player as any).findFirst = async (args: any) => {
        const owner = await findOwner(args);
        if (args.where.NOT?.discordSnowflake === "game-claim") {
          claimRead.release();
          await releaseClaim.wait;
        }
        return owner;
      };
      registering = run("game-claim", "CurrentName");
      await claimRead.wait;
      signing = new EventService(eventDb).signup("guild", "cup", "event-claim", {
        answers: {}, formRevision: 0, acceptedTerms: true,
        minecraftUsername: "CurrentName", expectedMinecraftUUID: uuid.toUpperCase(),
      }).then(() => "signed", (error) => String(error));
      await eventPrepared.wait;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assertEqual(eventTransactions, 0, "Event must not enter its transaction before game identity commit");
      releaseClaim.release();
      assert(/successfully registered/.test(await registering), "First claimant succeeds");
      assert(/already linked/.test(await signing), "Event rechecks ownership after waiting");
      assertEqual(eventWrites, 0, "Rejected event creates no competing profile");
      assertEqual([...rows.values()].filter((row) => row.primaryMinecraftAccount?.toLowerCase() === uuid).length, 1, "One UUID has one owner");
    } finally {
      releaseClaim.release();
      await registering?.catch(() => {});
      await signing?.catch(() => {});
      prismaClient.player.findFirst = findOwner;
    }

    // Reverse the ordering: event transaction holds the write, game
    // verification finishes, then the game must observe the committed owner.
    reset();
    eventTransactions = eventWrites = 0;
    const eventWriting = gate(), finishEvent = gate(), gameVerified = gate();
    const eventUpsert = eventDb.player.upsert;
    const previousReverse = MojangAPI.uuidToUsername;
    let gameOwnershipChecks = 0;
    registering = signing = undefined;
    try {
      eventDb.player.upsert = async (args: any) => {
        eventWriting.release();
        await finishEvent.wait;
        return eventUpsert(args);
      };
      (prismaClient.player as any).findFirst = async (args: any) => {
        if (args.where.NOT?.discordSnowflake === "game-claim") gameOwnershipChecks++;
        return findOwner(args);
      };
      MojangAPI.uuidToUsername = async (...args) => {
        const resolved = await previousReverse(...args);
        gameVerified.release();
        return resolved;
      };
      signing = new EventService(eventDb).signup("guild", "cup", "event-claim", {
        answers: {}, formRevision: 0, acceptedTerms: true,
        minecraftUsername: "CurrentName",
      }).then(() => "signed", (error) => String(error));
      await eventWriting.wait;
      registering = run("game-claim", "CurrentName");
      await gameVerified.wait;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assertEqual(gameOwnershipChecks, 0, "Game ownership read waits for event transaction");
      finishEvent.release();
      assertEqual(await signing, "signed", "Event claimant succeeds");
      assert(/already linked/.test(await registering), "Game rechecks ownership after event commits");
      assertEqual(game.getPlayers().length + creates + writes, 0, "Rejected game creates no profile or roster entry");
      assertEqual(eventWrites, 1, "Only the event writes an identity");
    } finally {
      finishEvent.release();
      await signing?.catch(() => {});
      await registering?.catch(() => {});
      eventDb.player.upsert = eventUpsert;
      prismaClient.player.findFirst = findOwner;
      MojangAPI.uuidToUsername = previousReverse;
    }

    reset();
    rows.set("hook", record("hook"));
    failHook = true;
    const hookReply = await run("hook");
    assert(/successfully registered/.test(hookReply) && /Scenario synchronisation failed/.test(hookReply), "Committed registration reports scenario failure as a warning");
    assertEqual(game.getPlayers().length, 1, "Scenario failure retains committed registration");

    reset();
    statsMissing = failStats = true;
    assert(!/successfully registered/.test(await run("stats-retry", "CurrentName")), "Statistics failure prevents roster insertion");
    assertEqual(game.getPlayers().length, 0, "No incomplete roster entry");
    failStats = false;
    assert(/successfully registered/.test(await run("stats-retry", "CurrentName")), "Retry repairs incomplete player");
    assertEqual(creates, 1, "Retry reuses the existing profile");
    assertEqual(statsCreates, 2, "The failed statistics creation is retried exactly once");
    assert(!statsMissing && game.getPlayers().length === 1, "Statistics exist before the sole roster insertion");

    reset();
    rows.set("replacement", record("replacement"));
    replaceDuringMembership = true;
    assert(/game changed/.test(await run("replacement")), "Replacement during final membership fetch is rejected");
    assertEqual(game.getPlayers().length + writes, 0, "Replacement game receives no registration or write");
    assertEqual(reads, 1, "Obsolete registration never enters database commit");

    reset();
    const raw = await game.addPlayerByDiscordId("raw", "CurrentName", uuid as unknown as RegistrationIdentity);
    assert(!!raw.error && creates === 0, "Caller-supplied UUID is not verification evidence");

    const prepared = await RegistrationIdentity.prepare("wrong-target", game.getLifecycleToken(), null, "CurrentName");
    assert("identity" in prepared, "Preparation succeeded");
    if ("identity" in prepared) {
      const mismatched = await game.addPlayerByDiscordId("other-target", "CurrentName", prepared.identity);
      assert(!!mismatched.error && creates === 0, "Prepared evidence is bound to its original Discord member");
    }
  } finally {
    game.addPlayerByDiscordId = originalAdd;
    game.scenarios.onRegistrationChanged = originalHook;
    TeamCommand.instance = priorTeam;
    (prismaClient as any).player.byDiscordSnowflake = originalLookup;
    (prismaClient as any).player.findFirst = originalFindFirst;
    (prismaClient as any).player.create = originalCreate;
    (prismaClient as any).player.update = originalUpdate;
    (prismaClient as any).playerStats = originalStats;
    (prismaClient as any).season = originalSeason;
    (prismaClient as any).profile = originalProfile;
    (prismaClient as any).playerPunishment = originalPunishment;
    PrismaUtils.updatePunishmentsForExpiry = originalExpiry;
    MojangAPI.usernameToUUID = originalForward;
    MojangAPI.uuidToUsername = originalReverse;
    game.reset();
  }
});

test("membership verification is bounded and atomic across batches and replacement games", async () => {
  const game = GameInstance.getInstance();
  const previous = TeamCommand.instance;
  const command = new TeamCommand();
  const guild = new FakeGuild() as any;
  let active = 0, peak = 0, calls = 0;
  let fail = true, replace = false;
  const populate = () => {
    game.reset();
    game.announced = true;
    game.teams.UNDECIDED.push(...Array.from({ length: 7 }, (_, i) => ({ discordSnowflake: "check" + i } as any)));
  };
  guild.members.fetch = async ({ user, force }: any) => {
    assert(force, "Every roster lookup is authoritative");
    calls++;
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    if (replace && user === "check0") {
      game.reset();
      game.announced = true;
      game.teams.UNDECIDED.push({ discordSnowflake: "check0" } as any);
    }
    if (user === "check0") throw Object.assign(new Error("Unknown Member"), { code: 10007 });
    if (fail && user === "check5") throw Object.assign(new Error("Temporary Discord failure"), { code: 503 });
    return { id: user };
  };
  try {
    populate();
    let rejected = false;
    try { await GuildMembership.reconcile(guild, command); } catch { rejected = true; }
    assert(rejected, "A later batch failure aborts reconciliation");
    assertEqual(game.getPlayers().length, 7, "Confirmed departures are not removed on partial verification");
    assertEqual(peak, 4, "Maximum of four checks in flight");
    assertEqual(calls, 7, "All requests in the failed batch settle");
    assertEqual(active, 0, "No pending checks after failure");

    fail = false;
    const removed = await GuildMembership.reconcile(guild, command);
    assertEqual(removed.join(","), "check0", "Only confirmed departure removed");
    assertEqual(game.getPlayers().length, 6, "Remaining roster retained");

    populate();
    replace = true;
    rejected = false;
    try { await GuildMembership.reconcile(guild, command); } catch { rejected = true; }
    assert(rejected, "Replacement game aborts reconciliation");
    assertEqual(game.getPlayers().length, 1, "Replacement roster untouched");
    assertEqual(game.getPlayers()[0].discordSnowflake, "check0", "Matching Discord ID in replacement is not removed");
  } finally {
    TeamCommand.instance = previous;
    game.reset();
  }
});
