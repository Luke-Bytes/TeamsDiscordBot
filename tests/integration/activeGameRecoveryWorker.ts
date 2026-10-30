/**
 * Real child-process recovery exercise. No Discord login or Prisma connection.
 * Launch only via the parent integration test; never use as a service command.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AnniClass, AnniMap } from "@prisma/client";
import { GameInstance } from "../../src/database/GameInstance";
import { PlayerInstance } from "../../src/database/PlayerInstance";
import { GameRecoveryCoordinator, GameSnapshotStore, createGameSnapshot, recoverPendingGame } from "../../src/logic/ActiveGameRecovery";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";
import { MapVoteManager } from "../../src/logic/MapVoteManager";
import TeamCommand from "../../src/commands/TeamCommand";
import RestartCommand from "../../src/commands/RestartCommand";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { FakeGuild, FakeGuildMember, createChatInputInteraction } from "../framework/mocks";

const mode = process.argv[2];
const directory = process.argv[3];
if (!directory || !mode) throw new Error("Worker requires a mode and a disposable directory");
const store = new GameSnapshotStore(directory);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function populateGame() {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  game.gameId = game.getLifecycleToken();
  game.startTime = new Date("2026-11-04T20:00:00.000Z");
  game.organiser = "local-test-organiser";
  game.host = "local-test-host";
  for (let i = 0; i < 20; i++) {
    const id = String(900000000000000000n + BigInt(i));
    const player = {
      playerId: `local-test-player-${i}`, discordSnowflake: id,
      minecraftAccounts: [`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${i}`],
      primaryMinecraftAccount: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${i}`,
      latestIGN: `LocalTest${i}`, ignUsed: `LocalTest${i}`,
      captain: i < 2, draftSlotPlacement: null,
      elo: 1200 + i, wins: 3, losses: 2,
      winStreak: 1, loseStreak: 0, biggestWinStreak: 2, biggestLosingStreak: 2,
    } as unknown as PlayerInstance;
    if (i === 0 || (i > 1 && i < 7)) game.teams.RED.push(player);
    else if (i === 1 || (i > 6 && i < 12)) game.teams.BLUE.push(player);
    else game.teams.UNDECIDED.push(player);
  }
  game.settings.map = AnniMap.ARID1V1;
  game.settings.organiserBannedClasses = [AnniClass.ACROBAT];
  game.settings.sharedCaptainBannedClasses = [AnniClass.ARCHER];
  game.settings.nonSharedCaptainBannedClasses.RED = [AnniClass.SCOUT];
  game.settings.modifiers = [{ category: "Minerushing", name: "Always" }];
  game.settings.delayedBan = 2;
  game.classBanMode = "opponentOnly";
  game.setClassBanLimit(4);
  game.markCaptainHasBanned(game.teams.RED[0].discordSnowflake);
  game.lockCaptainBan(game.teams.RED[0].discordSnowflake);
  game.markClassBansAnnounced();
  game.noElo = true;
  game.isDoubleElo = true;
  game.lateSignups.add(game.teams.UNDECIDED[0].discordSnowflake);
  game.captainNominations.add(game.teams.RED[0].discordSnowflake);
  game.lastRegisteredSnowflake = game.teams.UNDECIDED[0].discordSnowflake;
  game.announcementMessage = { id: "fake-announcement", channelId: "test-channel" } as any;
  game.announcementPingMessage = { id: "fake-ping", channelId: "test-channel" } as any;
  game.startTime = new Date("2026-11-04T20:00:00.000Z");

  const teamCommand = new TeamCommand();
  const draft = new DraftTeamPickingSession("snake");
  draft.turn = "BLUE";
  draft.proposedTeams = {
    RED: [...game.teams.RED, game.teams.UNDECIDED[0]],
    BLUE: [...game.teams.BLUE, game.teams.UNDECIDED[1]],
    UNDECIDED: game.teams.UNDECIDED.slice(2),
  };
  teamCommand.teamPickingSession = draft;
  game.mapVoteManager = new MapVoteManager([AnniMap.ARID1V1]);
  (game.mapVoteManager as any).pollMessage = { id: "fake-poll", channelId: "test-channel" };
  return { game, teamCommand };
}

async function assertRestored() {
  const game = GameInstance.getInstance();
  assert(game.announced && game.getRegisteredPlayerCount() === 20, "lost the 20-player announcement");
  assert(game.startTime?.toISOString() === "2026-11-04T20:00:00.000Z", "lost scheduled start time");
  assert(game.teams.RED.length === 6 && game.teams.BLUE.length === 6 && game.teams.UNDECIDED.length === 8, "roster assignments changed");
  assert(game.getCaptainOfTeam("RED") && game.getCaptainOfTeam("BLUE"), "captains missing");
  assert(game.settings.map === AnniMap.ARID1V1 && game.classBanMode === "opponentOnly", "settings changed");
  assert(game.getCaptainBanCount(game.teams.RED[0].discordSnowflake) === 1, "ban counts changed");
  assert(game.isDoubleElo && game.noElo, "Elo flags changed");
  assert(game.recoveryDraftProgress?.turn === "BLUE", "draft progress was not retained for review");
  assert(game.recoveryPausedWorkflows.some((s) => s.includes("map vote")), "poll must remain paused");
  assert(!game.mapVoteManager, "poll restarted unexpectedly");
  assert(new Set(game.getPlayers().map((p) => p.discordSnowflake)).size === 20, "duplicated registration");
  const guild = new FakeGuild() as any;
  const member = new FakeGuildMember("local-test-reviewer");
  guild.addMember(member);
  const interaction = createChatInputInteraction("local-test-reviewer", {
    guild, member, commandName: "team", subcommand: "list",
  });
  const command = new TeamCommand();
  await command.execute(interaction);
  assert(interaction.replies.some((r: any) => r.type === "editReply"), "team list cannot operate on restored game");
}
async function run() {
  if (mode === "save-exit") {
    const { game, teamCommand } = populateGame();
    TeamCommand.instance = teamCommand;
    (PermissionsUtil as any).hasRole = () => true;
    const command = new RestartCommand(() => store);
    let buttonId = "";
    const fakeSlash = {
      member: {}, user: { id: "local-test-organiser" }, guildId: "dev-test",
      options: { getBoolean: () => true },
      reply: async (payload: any) => {
        buttonId = payload.components[0].components[0].data.custom_id;
      },
    };
    await command.execute(fakeSlash as any);
    assert(buttonId.startsWith("confirm_restart:"), "preserve confirmation not registered");
    command.restartBot = () => {
      console.log("WORKER: PRESERVED_RESTART_PROCESS_EXIT");
      process.exit(51);
    };
    await command.handleButtonPress({
      customId: buttonId, member: {}, user: { id: "local-test-organiser" },
      guildId: "dev-test", update: async () => {}, editReply: async () => {},
    } as any);
    throw new Error("restart process did not exit");
  }
  if (mode === "restore") {
    GameRecoveryCoordinator.beginStartup();
    const snapshot = await recoverPendingGame(store, GameInstance.getInstance(), null);
    assert(snapshot, "no pending snapshot after restart");
    GameRecoveryCoordinator.finishStartup(null);
    await assertRestored();
    assert(!(await store.existsPending()), "snapshot incorrectly left pending");
    console.log("WORKER: RESTORED_GAME_AND_COMMANDS");
    return;
  }
  if (mode === "second-boot") {
    GameRecoveryCoordinator.beginStartup();
    const snapshot = await recoverPendingGame(store, GameInstance.getInstance(), null);
    assert(snapshot === null && !GameInstance.getInstance().announced, "replayed a consumed snapshot");
    GameRecoveryCoordinator.finishStartup(null);
    console.log("WORKER: NO_DUPLICATE_REPLAY");
    return;
  }
  if (mode === "filesystem-smoke") {
    const { game, teamCommand } = populateGame();
    const original = createGameSnapshot(game, teamCommand);
    await store.save(original);
    assert((await store.readPending())?.snapshotId === original.snapshotId,
      "snapshot could not be read from the mounted filesystem");
    game.reset();
    const restored = await recoverPendingGame(store, game, null);
    assert(restored?.snapshotId === original.snapshotId, "mounted filesystem restore failed");
    await assertRestored();
    assert(!(await store.existsPending()), "consumed file still pending");
    console.log("WORKER: MOUNTED_FILESYSTEM_ATOMIC_LINKS_OK");
    return;
  }
  if (mode === "io-failure") {
    const { game, teamCommand } = populateGame();
    TeamCommand.instance = teamCommand;
    (PermissionsUtil as any).hasRole = () => true;
    const invalidPath = path.join(directory, "not-a-directory");
    await fs.writeFile(invalidPath, "blocking-file");
    const command = new RestartCommand(() => new GameSnapshotStore(invalidPath));
    let exitCount = 0;
    command.restartBot = () => { exitCount++; };
    let buttonId = "";
    await command.execute({
      member: {}, user: { id: "local-test-organiser" }, guildId: "dev-test",
      options: { getBoolean: () => true },
      reply: async (payload: any) => { buttonId = payload.components[0].components[0].data.custom_id; },
    } as any);
    await command.handleButtonPress({
      customId: buttonId, member: {}, user: { id: "local-test-organiser" },
      guildId: "dev-test", update: async () => {}, editReply: async () => {},
    } as any);
    assert(exitCount === 0, "restarted despite filesystem failure");
    assert(!GameRecoveryCoordinator.isFrozen(), "unrecoverable game freeze after rejected save");
    assert(game.getRegisteredPlayerCount() === 20, "failed save destroyed roster");
    console.log("WORKER: FAILED_SAVE_NO_EXIT");
    return;
  }
  if (mode === "corrupt-startup" || mode === "orphan-startup") {
    GameRecoveryCoordinator.beginStartup();
    let failed = false;
    try { await recoverPendingGame(store, GameInstance.getInstance(), null); }
    catch { failed = true; }
    assert(failed, "unsafe startup was accepted");
    assert(!GameInstance.getInstance().announced, "partial corrupted game was exposed");
    console.log("WORKER: UNSAFE_STARTUP_BLOCKED");
    return;
  }
  if (mode === "partial-write-kill") {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, ".writing-interrupted"), '{"schemaVersion":1');
    console.log("WORKER: WRITE_INTERRUPTION_READY");
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "linked-crash") {
    const { game, teamCommand } = populateGame();
    const snapshot = createGameSnapshot(game, teamCommand);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.writing-${snapshot.snapshotId}`);
    const handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(snapshot), "utf8");
    await handle.sync();
    await handle.close();
    await fs.link(temporary, store.pendingPath);
    console.log("WORKER: PUBLISHED_PENDING_BEFORE_CLEANUP");
    process.exit(73);
  }
  if (mode === "archived-crash") {
    const snapshot = await store.readPending();
    assert(snapshot, "cannot archive absent pending");
    const consumed = path.join(directory, "consumed");
    await fs.mkdir(consumed, { recursive: true });
    await fs.link(store.pendingPath, path.join(consumed, `${snapshot.snapshotId}.json`));
    console.log("WORKER: PUBLISHED_ARCHIVE_BEFORE_UNLINK");
    process.exit(74);
  }
  if (mode === "match-gate") {
    const { game, teamCommand } = populateGame();
    await store.save(createGameSnapshot(game, teamCommand));
    game.reset();
    GameRecoveryCoordinator.beginStartup();
    let blocked = false;
    try { await recoverPendingGame(store, game, "pending completed match cleanup"); }
    catch { blocked = true; }
    assert(blocked, "completed match gate was bypassed");
    assert(await store.existsPending(), "conflicting snapshot lost");
    assert(!game.announced, "conflicting game state installed");
    console.log("WORKER: COMPLETED_MATCH_GATE_RETAINED");
    return;
  }
  throw new Error(`unknown integration mode ${mode}`);
}
run().catch((error) => {
  console.error("WORKER FAILURE:", error);
  process.exitCode = 1;
});
