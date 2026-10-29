import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { FakeGuild, FakeGuildMember, createChatInputInteraction } from "../framework/mocks";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { AutoCaptainSelector } from "../../src/logic/AutoCaptainSelector";
import CaptainNominateCommand from "../../src/commands/CaptainNominate";
import TeamCommand from "../../src/commands/TeamCommand";
import GameCommand, { assignTeamRolesAfterPicking } from "../../src/commands/GameCommand";
import VerifyCommand from "../../src/commands/VerifyCommand";
import { ConfigManager } from "../../src/ConfigManager";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { MojangAPI } from "../../src/api/MojangAPI";
import { prismaClient } from "../../src/database/prismaClient";

function roster() {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.announced = true;
  const first = { discordSnowflake: "1001", ignUsed: "First", elo: 1350, captain: false };
  const second = { discordSnowflake: "1002", ignUsed: "Second", elo: 1400, captain: false };
  game.teams.RED = [];
  game.teams.BLUE = [];
  game.teams.UNDECIDED = [first, second] as any;
  return { game, first, second };
}

function nominationButton(customId: string, guild: FakeGuild, actor = "9000") {
  const responses: any[] = [];
  return {
    customId,
    guild,
    user: { id: actor },
    responses,
    deferReply: async (options: any) => responses.push({ type: "defer", options }),
    editReply: async (payload: any) => responses.push({ type: "edit", payload }),
  } as any;
}

test("automatic captains never select confirmed departed members", async () => {
  new TeamCommand();
  const { game } = roster();
  const guild = new FakeGuild();
  guild.addMember(new FakeGuildMember("1001"));
  const result = await AutoCaptainSelector.randomiseCaptains(guild as any);
  assert("error" in result, "Missing eligible player must block captain selection");
  assertEqual(game.getCaptainOfTeam("RED"), undefined, "Red must stay unassigned");
  assertEqual(game.getCaptainOfTeam("BLUE"), undefined, "Blue must stay unassigned");
  game.reset();
});

test("automatic captains abort on a transient lookup rather than assuming departure", async () => {
  new TeamCommand();
  const { game } = roster();
  const guild = new FakeGuild();
  guild.addMember(new FakeGuildMember("1001"));
  guild.addMember(new FakeGuildMember("1002"));
  const originalFetch = guild.members.fetch;
  guild.members.fetch = async (id: any) => {
    if ((typeof id === "string" ? id : id.user) === "1002")
      throw Object.assign(new Error("temporary outage"), { code: 503 });
    return originalFetch(id);
  };
  const result = await AutoCaptainSelector.randomiseCaptains(guild as any);
  assert("error" in result, "An uncertain lookup must abort");
  assertEqual(game.getCaptainOfTeam("RED"), undefined, "No role state committed");
  assertEqual(game.getCaptainOfTeam("BLUE"), undefined, "No role state committed");
  game.reset();
});

test("automatic captain role failure preserves game state", async () => {
  new TeamCommand();
  const { game } = roster();
  const guild = new FakeGuild();
  const first = guild.addMember(new FakeGuildMember("1001"));
  const second = guild.addMember(new FakeGuildMember("1002"));
  first.roles.add = async () => { throw Object.assign(new Error("missing permissions"), { code: 50013 }); };
  second.roles.add = async () => { throw Object.assign(new Error("missing permissions"), { code: 50013 }); };
  const result = await AutoCaptainSelector.randomiseCaptains(guild as any);
  assert("error" in result, "Role failure must be visible");
  assertEqual(game.getCaptainOfTeam("RED"), undefined, "Captain state must not change");
  assertEqual(game.getCaptainOfTeam("BLUE"), undefined, "Captain state must not change");
  game.reset();
});

test("old nomination buttons cannot affect a newly announced game", async () => {
  new TeamCommand();
  const { game } = roster();
  const version = game.getLifecycleToken();
  const guild = new FakeGuild();
  guild.addMember(new FakeGuildMember("9000", [ConfigManager.getConfig().roles.organiserRole]));
  guild.addMember(new FakeGuildMember("1001"));
  const command = new CaptainNominateCommand();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = [{ discordSnowflake: "1001", ignUsed: "First", captain: false }] as any;
  game.captainNominations.add("1001");
  const button = nominationButton(`captainnominate-set:${version}:1001`, guild);
  await command.handleButtonPress(button);
  assert(String(button.responses[1]?.payload).includes("expired"), "Must explain stale game");
  assertEqual(game.getCaptainOfTeam("RED"), undefined, "No captain should be added");
  game.reset();
});

test("nomination role failure does not add a captain", async () => {
  new TeamCommand();
  const { game } = roster();
  const guild = new FakeGuild();
  guild.addMember(new FakeGuildMember("9000", [ConfigManager.getConfig().roles.organiserRole]));
  const selected = guild.addMember(new FakeGuildMember("1001"));
  selected.roles.add = async () => { throw Object.assign(new Error("no permissions"), { code: 50013 }); };
  game.captainNominations.add("1001");
  const command = new CaptainNominateCommand();
  const button = nominationButton(`captainnominate-set:${game.getLifecycleToken()}:1001`, guild);
  await command.handleButtonPress(button);
  assert(String(button.responses[1]?.payload).includes("not changed"), "Must report partial role failure");
  assertEqual(game.getCaptainOfTeam("RED"), undefined, "No game-state commit");
  assertEqual(game.getCaptainOfTeam("BLUE"), undefined, "No game-state commit");
  game.reset();
});

test("game start aborts when a cached player has left since team finalisation", async () => {
  const { game } = roster();
  game.teams.RED = [game.teams.UNDECIDED[0]];
  game.teams.BLUE = [game.teams.UNDECIDED[1]];
  game.teams.UNDECIDED = [];
  const guild = new FakeGuild();
  guild.addMember(new FakeGuildMember("1001"));
  const original = PermissionsUtil.isUserAuthorised;
  (PermissionsUtil as any).isUserAuthorised = async () => true;
  const interaction = createChatInputInteraction("9000", { guild: guild as any, subcommand: "start" }) as any;
  interaction.client = { users: {} };
  try {
    await new GameCommand().execute(interaction);
    assertEqual(game.getGameStartStatus(), "idle", "Failed start must release lock");
    assert(interaction.replies.some((r: any) => r.type === "editReply" && String(r.payload?.content).includes("Failed to start")),
      "Failed start should be reported");
  } finally {
    (PermissionsUtil as any).isUserAuthorised = original;
    game.reset();
  }
});

test("team role assignment reports 50013 instead of silently succeeding", async () => {
  const { game } = roster();
  game.teams.RED = [game.teams.UNDECIDED[0]];
  game.teams.BLUE = [game.teams.UNDECIDED[1]];
  game.teams.UNDECIDED = [];
  const guild = new FakeGuild();
  const first = guild.addMember(new FakeGuildMember("1001"));
  guild.addMember(new FakeGuildMember("1002"));
  first.roles.add = async () => { throw Object.assign(new Error("denied"), { code: 50013 }); };
  let rejected = false;
  try {
    await assignTeamRolesAfterPicking(guild as any);
  } catch (error) {
    rejected = (error as any).code === 50013;
  }
  assert(rejected, "Role failure should reject the operation");
  game.reset();
});

test("verify acknowledges before Mojang requests and deduplicates uncertain names", async () => {
  const oldGetMember = DiscordUtil.getGuildMember;
  const oldLookup = MojangAPI.lookupUsername;
  const oldFind = (prismaClient.player as any).findMany;
  let lookupCalls = 0;
  (DiscordUtil as any).getGuildMember = () => ({
    roles: { cache: { has: () => true } },
  });
  (MojangAPI as any).lookupUsername = async () => { lookupCalls++; return { status: "unavailable" }; };
  (prismaClient.player as any).findMany = async () => [];
  const interaction = createChatInputInteraction("9000", {
    strings: { names: "Alice ALICE Bob" },
    booleans: { pingplayers: false },
  });
  try {
    await new VerifyCommand().execute(interaction);
    assertEqual(lookupCalls, 2, "Duplicate IGN should have one lookup");
    assert(interaction.deferred, "Should acknowledge promptly before external lookups");
    const result = interaction.replies.find((r: any) => r.type === "editReply");
    assert(String(result?.payload?.content).includes("service unavailable"), "Service outage must be distinguished from missing username");
    assert(!String(result?.payload?.content).includes("Invalid username"), "API outage must not claim invalid IGN");
  } finally {
    (DiscordUtil as any).getGuildMember = oldGetMember;
    (MojangAPI as any).lookupUsername = oldLookup;
    (prismaClient.player as any).findMany = oldFind;
  }
});
