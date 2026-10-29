import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { FakeGuild, FakeGuildMember, createChatInputInteraction } from "../framework/mocks";
import { MojangAPI } from "../../src/api/MojangAPI";
import { parseMassRegisterList } from "../../src/commands/MassRegisterCommand";
import MassRegisterCommand from "../../src/commands/MassRegisterCommand";
import UnregisterCommand from "../../src/commands/UnregisterCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { GuildMembership } from "../../src/logic/GuildMembership";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";
import { RandomTeamPickingSession } from "../../src/logic/teams/RandomTeamPickingSession";
import { fetchGuildMember, withObsoleteMessageGuard } from "../../src/util/DiscordFailures";
import { ConfigManager } from "../../src/ConfigManager";
import { prismaClient } from "../../src/database/prismaClient";

const uuidLookup = MojangAPI.usernameToUUID;
const validUuid = "0123456789abcdef0123456789abcdef";
const absent = () => Object.assign(new Error("Unknown Member"), { code: 10007 });
const transient = () => Object.assign(new Error("Discord unavailable"), { code: 50001 });
const player = (id: string, captain = false) =>
  ({ discordSnowflake: id, ignUsed: id, captain, elo: 1000 } as any);

test("massregister parses pasted syntax, newlines, tabs and duplicate names", () => {
  const result = parseMassRegisterList("/massregister playerlist: Alex\n alex\tSteve  Steve !bad");
  assert(result.names.join(",") === "Alex,Steve", "Unique, case-insensitive names");
  assert(result.invalid.join(",") === "!bad", "Bad Minecraft names rejected");
  assert(result.duplicates.join(",") === "alex,Steve", "Duplicates reported");
});

test("Mojang failure never returns a username or malformed UUID", async () => {
  const prior = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ status: 400, ok: false, headers: { get: () => null } })) as any;
    const id = await uuidLookup.call(MojangAPI, "UnverifiedOne");
    assert(id === null, "No unverified fallback identifier");
    assert(!MojangAPI.validUUID("UnverifiedOne"), "Username is not a UUID");
    assert(!MojangAPI.validUUID("not-a-uuid"), "Invalid stored UUID rejected");
  } finally {
    globalThis.fetch = prior;
  }
});

test("Mojang malformed primary payload falls back only to validated UUID", async () => {
  const prior = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { status: 200, ok: true, json: async () => ({ id: calls === 1 ? "not-uuid" : validUuid }) };
    }) as any;
    const result = await uuidLookup.call(MojangAPI, "FallbackValid");
    assert(result === validUuid, "Validated 32-char UUID returned");
    assert(calls === 2, "Malformed primary response required fallback");
  } finally {
    globalThis.fetch = prior;
  }
});

test("Discord 10007 differs from transient member lookup failure", async () => {
  const guild = new FakeGuild() as any;
  assert((await fetchGuildMember(guild, "gone")) === null, "10007 means departed");
  guild.members.fetch = async () => { throw transient(); };
  let threw = false;
  try { await fetchGuildMember(guild, "uncertain"); } catch { threw = true; }
  assert(threw, "Permission or transient failure is not treated as departure");
});

test("pre-start departures prune teams idempotently but started games retain history", async () => {
  const game = CurrentGameManager.getCurrentGame();
  const command = new TeamCommand();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED.push(player("undecided"));
  game.teams.RED.push(player("red"));
  game.teams.BLUE.push(player("blue"));
  assert(await GuildMembership.handleDeparture("undecided", command), "Undecided removed");
  assert(await GuildMembership.handleDeparture("red", command), "Red removed");
  assert(await GuildMembership.handleDeparture("blue", command), "Blue removed");
  assert(!await GuildMembership.handleDeparture("red", command), "Repeat departure no-op");
  assert(game.getPlayers().length === 0, "No departed players remain");
  game.teams.RED.push(player("historical"));
  assert(game.tryBeginGameStart() === "acquired", "Start lock");
  game.completeGameStart();
  assert(!await GuildMembership.handleDeparture("historical", command), "Started game untouched");
  assert(game.getPlayers().length === 1, "History participant retained");
  game.reset();
});

test("a departing captain cancels the active draft", async () => {
  const game = CurrentGameManager.getCurrentGame();
  const command = new TeamCommand();
  game.reset();
  game.announced = true;
  game.teams.RED.push(player("captain", true));
  const session = new DraftTeamPickingSession();
  let cancelled = 0;
  session.cancelSession = async () => { cancelled++; session.state = "cancelled"; };
  command.teamPickingSession = session;
  assert(await GuildMembership.handleDeparture("captain", command), "Captain removed");
  assert(cancelled === 1 && !command.teamPickingSession, "Draft cancelled and detached");
  assert(game.getPlayers().length === 0, "Captain no longer registered");
  game.reset();
});

test("a departed random-preview player is removed from proposed teams", async () => {
  const game = CurrentGameManager.getCurrentGame();
  const command = new TeamCommand();
  game.reset();
  game.announced = true;
  const p = player("preview");
  game.teams.RED.push(p);
  const session = new RandomTeamPickingSession();
  session.proposedTeams.RED.push(p);
  command.teamPickingSession = session;
  await GuildMembership.handleDeparture("preview", command);
  assert(!session.proposedTeams.RED.length && !game.getPlayers().length, "Preview and roster agree");
  game.reset();
});

test("offline reconciliation prunes 10007 but blocks on transient errors", async () => {
  const game = CurrentGameManager.getCurrentGame();
  const command = new TeamCommand();
  const guild = new FakeGuild() as any;
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED.push(player("offline"), player("stillHere"));
  guild.addMember(new FakeGuildMember("stillHere"));
  const removed = await GuildMembership.reconcile(guild, command);
  assert(removed.join(",") === "offline", "Unknown member removed");
  assert(game.getPlayers().length === 1, "Existing member preserved");
  guild.members.fetch = async () => { throw transient(); };
  let blocked = false;
  try { await GuildMembership.reconcile(guild, command); } catch { blocked = true; }
  assert(blocked && game.getPlayers().length === 1, "Transient failure blocks unsafe mutation");
  game.reset();
});

test("unregister during draft acknowledges once and synchronises the draft", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  const command = new TeamCommand();
  const session = new DraftTeamPickingSession();
  command.teamPickingSession = session;
  game.teams.UNDECIDED.push(player("self"));
  session.proposedTeams.UNDECIDED.push(player("self"));
  const guild = new FakeGuild() as any;
  guild.addMember(new FakeGuildMember("self"));
  const interaction = createChatInputInteraction("self", {
    guild, channelId: ConfigManager.getConfig().channels.registration
  }) as any;
  await new UnregisterCommand(command).execute(interaction);
  assert(interaction.deferred, "Initial acknowledgement was deferred");
  assert(interaction.replies.filter((r: any) => r.type === "reply").length === 0, "No duplicate reply");
  assert(interaction.replies.filter((r: any) => r.type === "editReply").length === 1, "One final edit");
  assert(game.getPlayers().length === 0 && session.proposedTeams.UNDECIDED.length === 0, "Draft synchronised");
  game.reset();
});

test("old session message buttons cannot affect the new session", async () => {
  const command = new TeamCommand();
  const session = new RandomTeamPickingSession();
  session.embedMessage = { id: "new-message" } as any;
  command.teamPickingSession = session;
  let responded = 0;
  await command.handleButtonPress({
    guild: new FakeGuild(),
    message: { id: "old-message" },
    reply: async () => { responded++; },
    customId: "random-team-accept",
  } as any);
  assert(responded === 1, "Stale button rejected with one reply");
  assert(session.state === "inProgress", "New session untouched");
});

test("obsolete 10008 message deletion is recoverable but other errors propagate", async () => {
  await withObsoleteMessageGuard("delete", { id: "old", channelId: "x" }, async () => { throw Object.assign(new Error("missing"), { code: 10008 }); });
  let rejected = false;
  try {
    await withObsoleteMessageGuard("delete", { id: "new" }, async () => { throw transient(); });
  } catch { rejected = true; }
  assert(rejected, "Unexpected message failure propagated");
});

test("massregister reports departed accounts and does not mutate the roster", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  const guild = new FakeGuild() as any;
  const organiser = new FakeGuildMember("organiser");
  await organiser.roles.add(ConfigManager.getConfig().roles.organiserRole);
  guild.addMember(organiser);
  const original = prismaClient.player.findFirst;
  try {
    (prismaClient as any).player.findFirst = async () => ({
      discordSnowflake: "departed", latestIGN: "Departed",
    });
    const interaction = createChatInputInteraction("organiser", {
      guild, member: organiser,
      strings: { playerlist: "Departed Departed" },
    });
    await new MassRegisterCommand().execute(interaction);
    const edits = interaction.replies.filter((r: any) => r.type === "editReply");
    assert(interaction.deferred && edits.length === 1, "Deferred with one final edit");
    assert(String(edits[0].payload).includes("left server"), "Explains departed member");
    assert(game.getPlayers().length === 0, "No departed registrations");
  } finally {
    (prismaClient as any).player.findFirst = original;
    game.reset();
  }
});
