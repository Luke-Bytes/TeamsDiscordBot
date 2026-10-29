import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { MojangAPI } from "../../src/api/MojangAPI";
import { GuildMembership } from "../../src/logic/GuildMembership";
import { RandomTeamPickingSession } from "../../src/logic/teams/RandomTeamPickingSession";
import TeamCommand from "../../src/commands/TeamCommand";
import UnregisterCommand from "../../src/commands/UnregisterCommand";
import { FakeGuild, FakeGuildMember, createChatInputInteraction } from "../framework/mocks";
import { ConfigManager } from "../../src/ConfigManager";
import MassRegisterCommand from "../../src/commands/MassRegisterCommand";
import { prismaClient } from "../../src/database/prismaClient";
import { PlayerInstance } from "../../src/database/PlayerInstance";
import { GameInstance } from "../../src/database/GameInstance";

const participant = (id: string) => ({
  discordSnowflake: id, ignUsed: id, captain: false, elo: 1200,
} as any);
const uuid = "abcdef0123456789abcdef0123456789";
const verifiedLookup = MojangAPI.usernameToUUID;

test("429 rate limit retries at most once and validates the recovered UUID", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return {
        status: 429, ok: false, headers: { get: () => "0" },
      };
      return { status: 200, ok: true, json: async () => ({ id: uuid }) };
    }) as any;
    const result = await verifiedLookup.call(MojangAPI, "RateLimitedCase");
    assert(result === uuid, "Retry accepted a verified identifier");
    assert(calls === 2, "Exactly one bounded retry");
  } finally {
    globalThis.fetch = original;
  }
});

test("random preview does not mutate the registered roster until accepted", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED.push(...["a", "b", "c", "d"].map(participant));
  const session = new RandomTeamPickingSession("balance");
  const interaction: any = {
    deferred: true, replied: false,
    editReply: async () => ({
      id: "preview", embeds: [],
      edit: async () => {}, delete: async () => {},
    }),
  };
  await session.initialize(interaction);
  assert(game.teams.UNDECIDED.length === 4, "Preview has no roster side effects");
  assert(!game.teams.RED.length && !game.teams.BLUE.length, "No teams committed yet");
  assert(!game.getPlayers().some((p) => p.captain), "No premature captain mutation");
  await session.cancelSession();
  assert(game.teams.UNDECIDED.length === 4, "Cancellation retains the complete roster");
  game.reset();
});

test("role failure at random finalisation blocks the start prompt and retains registration", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED.push(participant("a"), participant("b"));
  const command = new TeamCommand();
  const session = new RandomTeamPickingSession();
  await session.initialize({
    deferred: true, replied: false,
    editReply: async () => ({
      id: "current-preview", embeds: [],
      edit: async () => {}, delete: async () => {},
    }),
  } as any);
  command.teamPickingSession = session;
  const guild = new FakeGuild() as any;
  const badMember = new FakeGuildMember("a");
  const goodMember = new FakeGuildMember("b");
  const failure = Object.assign(new Error("Missing permissions"), { code: 50013 });
  badMember.roles.add = async () => { throw failure; };
  guild.addMember(badMember);
  guild.addMember(goodMember);
  const followUps: any[] = [];
  await command.handleButtonPress({
    guild, customId: "random-team-accept", message: { id: "current-preview" },
    update: async () => {}, followUp: async (content: any) => followUps.push(content),
  } as any);
  assert(game.getPlayers().length === 2, "Both registrations are preserved");
  assert(followUps.length === 1 && String(followUps[0]?.content).includes("Do not start"),
    "Role failure produces explicit warning, not start prompt");
  game.reset();
});

test("reconciliation aborts atomically when a later member lookup is transient", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED.push(participant("absent"), participant("uncertain"));
  const guild = new FakeGuild() as any;
  guild.members.fetch = async ({ user }: any) => {
    if (user === "absent") throw Object.assign(new Error("Unknown Member"), { code: 10007 });
    throw Object.assign(new Error("Discord temporarily unavailable"), { code: 503 });
  };
  let blocked = false;
  try { await GuildMembership.reconcile(guild, new TeamCommand()); }
  catch { blocked = true; }
  assert(blocked, "Transient failure blocks reconciliation");
  assert(game.getPlayers().length === 2, "No partial roster removal");
  game.reset();
});

test("concurrent unregisters cannot remove twice or emit duplicate initial replies", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED.push(participant("member"));
  const guild = new FakeGuild() as any;
  guild.addMember(new FakeGuildMember("member"));
  const cfg = ConfigManager.getConfig();
  const cmd = new UnregisterCommand(new TeamCommand());
  const interactions = [1, 2].map(() => createChatInputInteraction("member", {
    guild, channelId: cfg.channels.registration,
  }) as any);
  await Promise.all(interactions.map((i) => cmd.execute(i)));
  assert(game.getPlayers().length === 0, "One successful removal");
  for (const interaction of interactions) {
    assert(interaction.replies.filter((r: any) => r.type === "reply").length <= 1,
      "No duplicate initial reply");
    assert(interaction.replies.some((r: any) => ["reply", "editReply"].includes(r.type)),
      "Every command gives feedback");
  }
  game.reset();
});

test("a rejoining member does not resurrect a previous registration", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.teams.BLUE.push(participant("returning"));
  const command = new TeamCommand();
  assert(await GuildMembership.handleDeparture("returning", command), "Departure confirmed");
  const guild = new FakeGuild() as any;
  guild.addMember(new FakeGuildMember("returning"));
  const removed = await GuildMembership.reconcile(guild, command);
  assert(removed.length === 0 && game.getPlayers().length === 0,
    "Rejoin does not automatically register the user");
  game.reset();
});

test("player add role failure cannot silently drop an undecided registration", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED.push(participant("addFail"));
  const guild = new FakeGuild() as any;
  const member = new FakeGuildMember("addFail");
  member.roles.add = async () => {
    throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
  };
  guild.addMember(member);
  let failed = false;
  try { await game.addPlayerByNameOrDiscord("addFail", "BLUE", guild); }
  catch { failed = true; }
  assert(failed, "Role failure is propagated");
  assert(game.teams.UNDECIDED.length === 1 && game.teams.BLUE.length === 0,
    "Existing roster stays authoritative");
  game.reset();
});

test("an unverified Minecraft lookup cannot create an empty permanent profile", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  const previousLookup = MojangAPI.usernameToUUID;
  const previousPlayerLookup = prismaClient.player.byDiscordSnowflake;
  const previousCreate = PlayerInstance.byDiscordSnowflake;
  let created = false;
  try {
    (MojangAPI as any).usernameToUUID = async () => null;
    (prismaClient as any).player.byDiscordSnowflake = async () => null;
    (PlayerInstance as any).byDiscordSnowflake = async () => {
      created = true;
      throw new Error("Must never create an unverified profile");
    };
    // Call the real implementation even if another legacy test left an
    // instance-level stub on the singleton.
    const result = await GameInstance.prototype.addPlayerByDiscordId.call(
      game, "unverified", "NotVerified"
    );
    assert(!!result.error && !created, "No profile or stats created on unverified lookup");
  } finally {
    (MojangAPI as any).usernameToUUID = previousLookup;
    (prismaClient as any).player.byDiscordSnowflake = previousPlayerLookup;
    (PlayerInstance as any).byDiscordSnowflake = previousCreate;
    game.reset();
  }
});

test("expired massregister response never retries a successful mutation", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  const originalFindFirst = prismaClient.player.findFirst;
  const originalAdd = game.addPlayerByDiscordId;
  const guild = new FakeGuild() as any;
  const organizer = new FakeGuildMember("organizer");
  await organizer.roles.add(ConfigManager.getConfig().roles.organiserRole);
  guild.addMember(organizer);
  guild.addMember(new FakeGuildMember("registered"));
  let mutations = 0;
  let responses = 0;
  try {
    (prismaClient as any).player.findFirst = async () => ({
      discordSnowflake: "registered", latestIGN: "Verified",
    });
    (game as any).addPlayerByDiscordId = async () => {
      mutations++;
      game.teams.UNDECIDED.push(participant("registered"));
      return { error: false, playerInstance: game.teams.UNDECIDED[0] };
    };
    const interaction: any = createChatInputInteraction("organizer", {
      guild, member: organizer, strings: { playerlist: "Verified" },
    });
    interaction.editReply = async () => {
      responses++;
      throw Object.assign(new Error("Unknown interaction"), { code: 10062 });
    };
    await new MassRegisterCommand().execute(interaction);
    assert(mutations === 1 && game.getPlayers().length === 1, "One committed registration");
    assert(responses === 1, "Expired response is not retried");
  } finally {
    (prismaClient as any).player.findFirst = originalFindFirst;
    (game as any).addPlayerByDiscordId = originalAdd;
    game.reset();
  }
});

test("departed member cannot enter new teams through add-by-name", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED.push(participant("gone"));
  const guild = new FakeGuild() as any;
  assert(!(await game.addPlayerByNameOrDiscord("gone", "RED", guild)), "10007 blocks addition");
  assert(game.teams.UNDECIDED.length === 1 && !game.teams.RED.length,
    "Failed operation does not alter teams");
  game.reset();
});
