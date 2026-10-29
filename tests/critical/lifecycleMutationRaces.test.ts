import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { FakeGuild, FakeGuildMember, createChatInputInteraction } from "../framework/mocks";
import { GameInstance } from "../../src/database/GameInstance";
import PlayerCommand from "../../src/commands/PlayerCommand";
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

test("organiser player command does not change a started or completed roster", async () => {
  const game = GameInstance.getInstance();
  const guild = new FakeGuild();
  const organiser = guild.addMember(new FakeGuildMember("9000", [
    ConfigManager.getConfig().roles.organiserRole,
  ]));
  const command = new PlayerCommand();
  for (const finished of [false, true]) {
    game.reset();
    game.announced = true;
    game.teams.UNDECIDED = [{ discordSnowflake: "12345", ignUsed: "Alice" }] as any;
    game.tryBeginGameStart();
    game.completeGameStart();
    game.isFinished = finished;
    const interaction = createChatInputInteraction("9000", {
      subcommand: "add", strings: { player: "Alice", team: "BLUE" },
      member: organiser, guild: guild as any,
    });
    await command.execute(interaction);
    assertEqual(game.getPlayersOfTeam("BLUE").length, 0, "Cannot edit an in-progress/finished game");
    assert(interaction.replies.some((reply) =>
      reply.type === "editReply" && String(reply.payload).includes("before the game starts")),
      "Guard should explain why edits are rejected");
  }
  game.reset();
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
