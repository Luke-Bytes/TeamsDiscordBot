import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { FakeGuild, FakeGuildMember, createChatInputInteraction } from "../framework/mocks";
import { GameInstance } from "../../src/database/GameInstance";
import PlayerCommand from "../../src/commands/PlayerCommand";
import CaptainCommand from "../../src/commands/CaptainCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import { ConfigManager } from "../../src/ConfigManager";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { DiscordUtil } from "../../src/util/DiscordUtil";

test("captain timer callbacks captured before a reset cannot affect the next game", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  game.startTime = new Date(Date.now() + 40 * 60_000);
  const oldSetTimeout = global.setTimeout;
  const oldClearTimeout = global.clearTimeout;
  const oldSend = DiscordUtil.sendMessage;
  const callbacks: Array<() => Promise<void>> = [];
  let sent = 0;
  (global as any).setTimeout = (fn: () => Promise<void>) => {
    callbacks.push(fn);
    return { fakeTimer: true };
  };
  (global as any).clearTimeout = () => {};
  (DiscordUtil as any).sendMessage = async () => { sent += 1; };
  try {
    CurrentGameManager.scheduleCaptainTimers(new FakeGuild() as any);
    assertEqual(callbacks.length, 2, "Reminder and enforcement should be scheduled");
    game.reset();
    game.announced = true;
    for (const callback of callbacks) await callback();
    assertEqual(sent, 0, "Old timer must not message the new game");
    assert(game.announced, "Old enforcement must not cancel the new game");
  } finally {
    (CurrentGameManager as any).clearCaptainTimers();
    (global as any).setTimeout = oldSetTimeout;
    (global as any).clearTimeout = oldClearTimeout;
    (DiscordUtil as any).sendMessage = oldSend;
    game.reset();
  }
});

test("a roster edit whose member fetch completes after reset cannot populate the next game", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = [{ discordSnowflake: "12345", ignUsed: "Alice" }] as any;
  const guild = new FakeGuild();
  const member = guild.addMember(new FakeGuildMember("12345"));
  let signalFetch!: () => void;
  let resumeFetch!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { signalFetch = resolve; });
  const fetchUnblocked = new Promise<void>((resolve) => { resumeFetch = resolve; });
  guild.members.fetch = async () => {
    signalFetch();
    await fetchUnblocked;
    return member;
  };
  const promise = game.addPlayerByNameOrDiscord("Alice", "BLUE", guild as any);
  await fetchStarted;
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = [{ discordSnowflake: "99999", ignUsed: "Next" }] as any;
  resumeFetch();
  assertEqual(await promise, false, "The old edit must fail without commit");
  assertEqual(game.getPlayersOfTeam("BLUE").length, 0, "New game team must remain empty");
  assertEqual(game.getPlayersOfTeam("UNDECIDED")[0].discordSnowflake, "99999",
    "The new roster must remain unchanged");
  game.reset();
});

test("organiser player command protects the in-progress start transition", async () => {
  const game = GameInstance.getInstance();
  const guild = new FakeGuild();
  const organiser = guild.addMember(new FakeGuildMember("9000", [
    ConfigManager.getConfig().roles.organiserRole,
  ]));
  const command = new PlayerCommand();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = [{ discordSnowflake: "12345", ignUsed: "Alice" }] as any;
  game.tryBeginGameStart();
  const interaction = createChatInputInteraction("9000", {
    subcommand: "add", strings: { player: "Alice", team: "BLUE" },
    member: organiser, guild: guild as any,
  });
  await command.execute(interaction);
  assertEqual(game.getPlayersOfTeam("BLUE").length, 0, "Cannot edit a mid-transition roster");
  game.reset();
});

test("organiser player command can add players after game end", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = [{ discordSnowflake: "12345", ignUsed: "Alice" }] as any;
  game.tryBeginGameStart();
  game.completeGameStart();
  game.isFinished = true;

  const guild = new FakeGuild();
  const roles = ConfigManager.getConfig().roles;
  const organiser = guild.addMember(new FakeGuildMember("9000", [roles.organiserRole]));
  guild.addMember(new FakeGuildMember("12345"));
  const oldFind = PrismaUtils.findPlayer;
  const previousTeamCommand = TeamCommand.instance;
  new TeamCommand();
  (PrismaUtils as any).findPlayer = async (name: string) => ({ latestIGN: name });
  try {
    const interaction = createChatInputInteraction(organiser.id, {
      subcommand: "add", strings: { player: "Alice", team: "BLUE" },
      member: organiser, guild: guild as any,
    });
    await new PlayerCommand().execute(interaction);
    assertEqual(game.getPlayersOfTeam("BLUE").length, 1,
      "Organiser can add to a finished game's roster");
    assert(
      interaction.replies.some((r) => r.type === "editReply" &&
        String(r.payload).includes("Successfully")),
      "A finished-game edit reports success"
    );
  } finally {
    (PrismaUtils as any).findPlayer = oldFind;
    TeamCommand.instance = previousTeamCommand;
    game.reset();
  }
});

test("organisers can add, move, replace and remove players during a started game", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = [
    { discordSnowflake: "12345", ignUsed: "Alice" },
    { discordSnowflake: "67890", ignUsed: "Bob" },
  ] as any;
  game.tryBeginGameStart();
  game.completeGameStart();
  const guild = new FakeGuild();
  const roles = ConfigManager.getConfig().roles;
  const organiser = guild.addMember(new FakeGuildMember("9000", [roles.organiserRole]));
  const alice = guild.addMember(new FakeGuildMember("12345"));
  const bob = guild.addMember(new FakeGuildMember("67890"));
  const oldFind = PrismaUtils.findPlayer;
  const oldTeamCommand = TeamCommand.instance;
  new TeamCommand();
  (PrismaUtils as any).findPlayer = async (name: string) => ({ latestIGN: name });
  const command = new PlayerCommand();
  const execute = async (subcommand: string, strings: Record<string, string>) => {
    const interaction = createChatInputInteraction("9000", {
      subcommand, strings, member: organiser, guild: guild as any,
    });
    await command.execute(interaction);
    assert(interaction.replies.some((reply) =>
      reply.type === "editReply" && String(reply.payload).includes("Successfully")),
      `${subcommand} should succeed during a game`);
  };
  try {
    await execute("add", { player: "Alice", team: "BLUE" });
    assertEqual(game.getPlayersOfTeam("BLUE")[0]?.ignUsed, "Alice", "Alice added to BLUE");
    assert(alice.roles.cache.has(roles.blueTeamRole), "Alice receives BLUE role");
    await execute("move", { player: "Alice", from: "BLUE", to: "RED" });
    assertEqual(game.getPlayersOfTeam("RED")[0]?.ignUsed, "Alice", "Alice moved to RED");
    assert(!alice.roles.cache.has(roles.blueTeamRole), "Alice loses BLUE role");
    assert(alice.roles.cache.has(roles.redTeamRole), "Alice receives RED role");
    await execute("replace", { old_player: "Alice", new_player: "Bob" });
    assertEqual(game.getPlayersOfTeam("RED")[0]?.ignUsed, "Bob", "Bob replaces Alice");
    assert(!alice.roles.cache.has(roles.redTeamRole), "Replaced player loses RED role");
    assert(bob.roles.cache.has(roles.redTeamRole), "Replacement receives RED role");
    await execute("remove", { player: "Bob" });
    assertEqual(game.getPlayersOfTeam("RED").length, 0, "Bob removed from RED");
    assert(!bob.roles.cache.has(roles.redTeamRole), "Removed player loses RED role");
  } finally {
    (PrismaUtils as any).findPlayer = oldFind;
    TeamCommand.instance = oldTeamCommand;
    game.reset();
  }
});

test("captain set and randomise work after finishing without moving players", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  game.teamsDecidedBy = "RANDOMISED";
  game.teams.BLUE = [
    { discordSnowflake: "old-blue", ignUsed: "OldBlue", captain: true, elo: 1500 },
    { discordSnowflake: "new-blue", ignUsed: "NewBlue", captain: false, elo: 1700 },
  ] as any;
  game.teams.RED = [
    { discordSnowflake: "red-captain", ignUsed: "RedCap", captain: true, elo: 1600 },
  ] as any;
  game.tryBeginGameStart();
  game.completeGameStart();
  game.isFinished = true;

  const guild = new FakeGuild();
  const roles = ConfigManager.getConfig().roles;
  const organiser = guild.addMember(new FakeGuildMember("captain-org", [roles.organiserRole]));
  guild.addMember(new FakeGuildMember("old-blue", [roles.captainRole, roles.blueTeamRole]));
  guild.addMember(new FakeGuildMember("new-blue", [roles.blueTeamRole]));
  guild.addMember(new FakeGuildMember("red-captain", [roles.captainRole, roles.redTeamRole]));
  const previousFind = PrismaUtils.findPlayer;
  const previousTeamCommand = TeamCommand.instance;
  const teamCommand = new TeamCommand();
  (PrismaUtils as any).findPlayer = async () => ({
    discordSnowflake: "new-blue",
  });
  try {
    const command = new CaptainCommand(teamCommand);
    const set = createChatInputInteraction(organiser.id, {
      guild: guild as any, member: organiser, subcommand: "set",
      strings: { user: "NewBlue", team: "blue" },
    });
    await command.execute(set);
    assert(
      set.replies.some((r) => r.type === "editReply" &&
        String(r.payload?.content).includes("Successfully set captain")),
      "Captain set succeeds after game end"
    );
    assert(game.getCaptainOfTeam("BLUE")?.discordSnowflake === "new-blue",
      "New captain replaces old after game end");
    assert(game.teams.BLUE.length === 2 && game.teams.RED.length === 1,
      "Finished game team membership stays unchanged");

    const randomise = createChatInputInteraction(organiser.id, {
      guild: guild as any, member: organiser, subcommand: "randomise",
    });
    await command.execute(randomise);
    assert(
      randomise.replies.some((r) => r.type === "editReply" &&
        String(r.payload).includes("Captains have been selected")),
      "Captain randomise also works after game end"
    );
    assert(game.teams.BLUE.length === 2 && game.teams.RED.length === 1,
      "Randomised captains do not change completed teams");
  } finally {
    (PrismaUtils as any).findPlayer = previousFind;
    TeamCommand.instance = previousTeamCommand;
    game.reset();
  }
});

test("concurrent organiser moves cannot introduce a duplicate player", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  game.teams.UNDECIDED = [{ discordSnowflake: "12345", ignUsed: "Alice" }] as any;
  const guild = new FakeGuild();
  const organiser = guild.addMember(new FakeGuildMember("9000", [
    ConfigManager.getConfig().roles.organiserRole,
  ]));
  const playerMember = guild.addMember(new FakeGuildMember("12345"));
  let enterRole!: () => void;
  let releaseRole!: () => void;
  const roleEntered = new Promise<void>((resolve) => { enterRole = resolve; });
  const roleReleased = new Promise<void>((resolve) => { releaseRole = resolve; });
  const originalAdd = playerMember.roles.add;
  let holdFirst = true;
  playerMember.roles.add = async (roleId) => {
    if (holdFirst) {
      holdFirst = false;
      enterRole();
      await roleReleased;
    }
    await originalAdd(roleId);
  };
  const oldFind = PrismaUtils.findPlayer;
  (PrismaUtils as any).findPlayer = async (name: string) =>
    ({ discordSnowflake: "12345", latestIGN: name });
  const command = new PlayerCommand();
  new TeamCommand();
  const make = (team: string) => createChatInputInteraction("9000", {
    subcommand: "add", strings: { player: "Alice", team },
    member: organiser, guild: guild as any,
  });
  try {
    const first = command.execute(make("BLUE"));
    await roleEntered;
    const second = command.execute(make("RED"));
    releaseRole();
    await Promise.all([first, second]);
    assertEqual(game.getPlayersOfTeam("BLUE").length, 1, "First edit should win");
    assertEqual(game.getPlayersOfTeam("RED").length, 0, "Second edit must not duplicate player");
    assertEqual(game.getPlayers().length, 1, "Registered player appears exactly once");
  } finally {
    (PrismaUtils as any).findPlayer = oldFind;
    TeamCommand.instance = undefined;
    game.reset();
  }
});
