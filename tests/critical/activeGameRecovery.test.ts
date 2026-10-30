import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { tmpdir } from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AnniClass, AnniMap } from "@prisma/client";
import { GameInstance } from "../../src/database/GameInstance";
import { GameSnapshotStore, GameRecoveryCoordinator, createGameSnapshot,
  validateGameSnapshot, recoverPendingGame, restoreGameSnapshot, GameSnapshot } from "../../src/logic/ActiveGameRecovery";
import { MapVoteManager } from "../../src/logic/MapVoteManager";
import TeamCommand from "../../src/commands/TeamCommand";
import RestartCommand from "../../src/commands/RestartCommand";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";
import { RandomTeamPickingSession } from "../../src/logic/teams/RandomTeamPickingSession";
import { Scheduler } from "../../src/util/SchedulerUtil";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { createChatInputInteraction, FakeGuild, FakeGuildMember } from "../framework/mocks";
import { TeamsBot } from "../../src/TeamsBot";
import AnnouncementCommand from "../../src/commands/AnnouncementCommand";
import { MatchRecoveryGate } from "../../src/logic/MatchRecoveryGate";

function player(id: string, captain = false) {
  return {
    playerId: `player-${id}`, discordSnowflake: id, ignUsed: `IGN${id}`,
    latestIGN: `IGN${id}`, primaryMinecraftAccount: `uuid-${id}`,
    minecraftAccounts: [`IGN${id}`], captain, draftSlotPlacement: 1,
    elo: 1080, wins: 3, losses: 2, winStreak: 1,
    loseStreak: 0, biggestWinStreak: 2, biggestLosingStreak: 1,
  } as any;
}

function setup(count = 20) {
  GameRecoveryCoordinator.resetForTests();
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  game.gameId = game.getLifecycleToken();
  game.startTime = new Date("2026-11-02T20:00:00.000Z");
  game.organiser = "organiser";
  game.host = "host";
  for (let i = 0; i < count; i++) {
    const p = player(String(100 + i), i === 0 || i === 1);
    if (i === 0) game.teams.RED.push(p);
    else if (i === 1) game.teams.BLUE.push(p);
    else if (i % 3 === 0) game.teams.RED.push(p);
    else if (i % 3 === 1) game.teams.BLUE.push(p);
    else game.teams.UNDECIDED.push(p);
  }
  game.settings.map = AnniMap.ARID1V1;
  game.settings.organiserBannedClasses = [AnniClass.ACROBAT];
  game.settings.sharedCaptainBannedClasses = [AnniClass.ARCHER];
  game.settings.nonSharedCaptainBannedClasses.RED = [AnniClass.SCOUT];
  game.settings.modifiers = [{ category: "Minerushing", name: "Always" }];
  game.settings.delayedBan = 5;
  game.classBanMode = "opponentOnly";
  game.setClassBanLimit(4);
  if (count > 0) {
    game.markCaptainHasBanned("100");
    game.lockCaptainBan("100");
  }
  game.markClassBansAnnounced();
  game.isDoubleElo = true;
  game.noElo = true;
  if (count > 0) {
    game.lateSignups.add(String(100 + count - 1));
    game.captainNominations.add("100");
    game.lastRegisteredSnowflake = String(100 + count - 1);
  }
  game.redTeamPlan = { midBlocks: "east", gamePlan: "defend", source: "DM", capturedAt: new Date("2026-10-29T10:00:00.000Z") };
  return game;
}

function digest(snapshot: GameSnapshot): GameSnapshot {
  const { checksum: _checksum, ...payload } = snapshot;
  return { ...payload, checksum: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

async function withStore(fn: (store: GameSnapshotStore, directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "teams-game-recovery-"));
  try { await fn(new GameSnapshotStore(directory), directory); }
  finally {
    await fs.rm(directory, { recursive: true, force: true });
    GameInstance.getInstance().reset();
    GameRecoveryCoordinator.resetForTests();
  }
}

test("Recovery rejects absent, starting, started and finished games", () => {
  const game = setup(0);
  game.announced = false;
  for (const configure of [
    () => { game.announced = false; },
    () => { game.announced = true; game.tryBeginGameStart(); },
    () => { game.tryBeginGameStart(); game.completeGameStart(); },
    () => { game.releaseGameStart(); game.isFinished = true; },
  ]) {
    game.reset();
    game.announced = true;
    game.gameId = game.getLifecycleToken();
    game.startTime = new Date("2026-11-02T20:00:00.000Z");
    configure();
    let failed = false;
    try { createGameSnapshot(game); } catch { failed = true; }
    assert(failed, "unsupported state should not be saved");
  }
  game.reset();
});

test("Recovery schema captures 20 players, captains, class bans and exact game identity", () => {
  const game = setup();
  const snapshot = createGameSnapshot(game);
  assertEqual(Object.values(snapshot.game.teams).flat().length, 20, "player count");
  assertEqual(snapshot.gameId, game.gameId, "game id");
  assertEqual(snapshot.lifecycleToken, game.getLifecycleToken(), "lifecycle");
  assertEqual(snapshot.game.startTime, "2026-11-02T20:00:00.000Z", "scheduled time");
  assert(snapshot.game.teams.RED[0].captain, "red captain");
  assert(snapshot.game.teams.BLUE[0].captain, "blue captain");
  assertEqual(snapshot.game.captainBanCounts[0][1], 1, "captain ban count");
  assertEqual(snapshot.game.classBanMode, "opponentOnly", "ban mode");
  assertEqual(snapshot.game.redTeamPlan?.midBlocks, "east", "plan");
  assertEqual(snapshot.game.lateSignups.length, 1, "late signup");
  assertEqual(snapshot.game.settings.map, AnniMap.ARID1V1, "map");
  game.reset();
});

test("Recovery keeps zero-player announcements and custom settings", async () => {
  await withStore(async (store) => {
    const game = setup(0);
    game.lateSignups.clear();
    game.lastRegisteredSnowflake = undefined;
    game.captainNominations.clear();
    const snapshot = createGameSnapshot(game);
    await store.save(snapshot);
    game.reset();
    await recoverPendingGame(store, game, null);
    assert(game.announced, "announced");
    assertEqual(game.getRegisteredPlayerCount(), 0, "zero roster");
    assertEqual(game.settings.modifiers[0].name, "Always", "modifier");
  });
});

test("Recovery restores authoritative teams, stats-in-memory and captain bans without duplication", async () => {
  await withStore(async (store) => {
    const game = setup();
    const original = createGameSnapshot(game);
    await store.save(original);
    game.reset();
    const restored = await recoverPendingGame(store, game, null);
    assertEqual(restored?.snapshotId, original.snapshotId, "same snapshot");
    assertEqual(game.gameId, original.gameId, "game id");
    assertEqual(game.getLifecycleToken(), original.lifecycleToken, "lifecycle token");
    assertEqual(game.startTime?.toISOString(), original.game.startTime, "date");
    assertEqual(game.getRegisteredPlayerCount(), 20, "all registered players");
    for (const team of ["RED", "BLUE", "UNDECIDED"] as const) {
      assertEqual(game.teams[team].map((p) => p.discordSnowflake).join(","),
        original.game.teams[team].map((p) => p.discordSnowflake).join(","), team);
    }
    assertEqual(new Set(game.getPlayers().map((p) => p.discordSnowflake)).size, 20, "no duplicates");
    assertEqual(game.getCaptainBanCount("100"), 1, "ban count");
    assert(game.isCaptainBanLocked("100"), "captain lock");
    assert(game.areClassBansAnnounced(), "announcement checkpoint");
    assertEqual(game.settings.organiserBannedClasses[0], AnniClass.ACROBAT, "ban list");
    assertEqual(game.redTeamPlan?.capturedAt.toISOString(), "2026-10-29T10:00:00.000Z", "plan date");
    assert(game.isDoubleElo && game.noElo, "settings flags");
    assertEqual(await store.readPending(), null, "consumed pending file");
    assertEqual(await recoverPendingGame(store, game, null), null, "not reapplied");
    const archived = await fs.readFile(path.join(store.pendingPath, "..", "consumed", `${original.snapshotId}.json`), "utf8");
    assertEqual(JSON.parse(archived).snapshotId, original.snapshotId, "archived");
  });
});

test("Recovery preserves paused draft picks, turn and provisional roster without executing them", async () => {
  await withStore(async (store) => {
    const game = setup(8);
    const command = new TeamCommand();
    const draft = new DraftTeamPickingSession("snake");
    draft.turn = "BLUE";
    draft.finishedPicking = false;
    draft.proposedTeams = {
      RED: [...game.teams.RED],
      BLUE: [...game.teams.BLUE, ...game.teams.UNDECIDED.slice(0, 2)],
      UNDECIDED: game.teams.UNDECIDED.slice(2),
    };
    draft.lateSignups = [game.teams.UNDECIDED[0]];
    command.teamPickingSession = draft;
    const snapshot = createGameSnapshot(game, command);
    assertEqual(snapshot.workflows.draft?.turn, "BLUE", "draft turn");
    assert(snapshot.workflows.paused.some((m) => m.includes("draft")), "paused draft diagnostics");
    await store.save(snapshot);
    game.reset();
    await recoverPendingGame(store, game, null);
    assertEqual(game.getRegisteredPlayerCount(), 8, "core roster retained");
    assertEqual(game.recoveryDraftProgress?.turn, "BLUE", "reviewable saved draft turn");
    assertEqual(game.recoveryDraftProgress?.mode, "snake", "draft method");
    assertEqual(game.teamsDecidedBy, null, "uncommitted picks not silently applied");
    command.teamPickingSession = undefined;
  });
});

test("Recovery preserves vote IDs and unconfirmed preview but does not recreate managers", async () => {
  await withStore(async (store) => {
    const game = setup(6);
    game.mapVoteManager = new MapVoteManager([AnniMap.ARID1V1]);
    (game.mapVoteManager as any).pollMessage = { id: "poll1", channelId: "channel1" };
    const cmd = new TeamCommand();
    const session = new RandomTeamPickingSession();
    session.proposedTeams = {
      RED: [...game.teams.RED], BLUE: [...game.teams.BLUE], UNDECIDED: [...game.teams.UNDECIDED],
    };
    cmd.teamPickingSession = session;
    const snapshot = createGameSnapshot(game, cmd);
    assertEqual(snapshot.workflows.mapVote?.messageId, "poll1", "poll id");
    assert(snapshot.workflows.preview !== null, "preview stored");
    await store.save(snapshot);
    game.reset();
    await recoverPendingGame(store, game, null);
    assertEqual(game.mapVoteManager, undefined, "no automatic poll reactivation");
    assert(game.recoveryPausedWorkflows.some((s) => s.includes("map vote")), "paused vote");
    cmd.teamPickingSession = undefined;
  });
});

test("Recovery validator rejects tampering, duplication, broken cross-references and unsupported version", () => {
  const game = setup();
  const original = createGameSnapshot(game);
  const variants: GameSnapshot[] = [];
  variants.push({ ...original, schemaVersion: 2 } as any);
  variants.push({ ...original, game: { ...original.game, host: "tampered" } });
  const duplicate = structuredClone(original);
  duplicate.game.teams.BLUE.push({ ...duplicate.game.teams.RED[0] });
  variants.push(digest(duplicate));
  const unknown = structuredClone(original);
  unknown.game.lateSignups = ["unknown"];
  variants.push(digest(unknown));
  const missing = structuredClone(original);
  delete (missing.game as any).settings;
  variants.push(digest(missing));
  for (const invalid of variants) {
    let failed = false;
    try { validateGameSnapshot(invalid); } catch { failed = true; }
    assert(failed, "invalid snapshot must fail");
  }
  game.reset();
});

test("Recovery validator rejects duplicate provisional draft and preview assignments", () => {
  const game = setup(6);
  const baseline = createGameSnapshot(game);
  const playerIds = game.getPlayers().map((p) => p.discordSnowflake);
  const proposedTeams = {
    RED: [playerIds[0], playerIds[2]],
    BLUE: [playerIds[1], playerIds[2]],
    UNDECIDED: playerIds.slice(3),
  };
  const invalidDraft = structuredClone(baseline);
  invalidDraft.workflows.draft = {
    mode: "draft", turn: "RED", proposedTeams, lateSignups: [],
    finishedPicking: false,
  };
  const invalidPreview = structuredClone(baseline);
  invalidPreview.workflows.preview = { proposedTeams };
  for (const variant of [invalidDraft, invalidPreview]) {
    let rejected = false;
    try { validateGameSnapshot(digest(variant)); } catch { rejected = true; }
    assert(rejected, "cross-team duplicate provisional assignment must be rejected");
  }
  game.reset();
});

test("Recovery completes an interrupted archive publication for the same snapshot", async () => {
  await withStore(async (store, directory) => {
    const game = setup(5);
    const snapshot = createGameSnapshot(game);
    await store.save(snapshot);
    const archived = path.join(directory, "consumed");
    await fs.mkdir(archived);
    const destination = path.join(archived, `${snapshot.snapshotId}.json`);
    // Simulate process termination after linking archive, before removing pending.
    await fs.link(store.pendingPath, destination);
    game.reset();
    await recoverPendingGame(store, game, null);
    assertEqual(game.gameId, snapshot.gameId, "restored original lifecycle");
    assertEqual(game.getRegisteredPlayerCount(), 5, "all players recovered");
    assertEqual(await store.readPending(), null, "pending consumption completed");
    assertEqual(JSON.parse(await fs.readFile(destination, "utf8")).snapshotId,
      snapshot.snapshotId, "same archive retained");
  });
});

test("Recovery refuses a conflicting archive and retains the pending snapshot", async () => {
  await withStore(async (store, directory) => {
    const game = setup(5);
    const snapshot = createGameSnapshot(game);
    await store.save(snapshot);
    const archived = path.join(directory, "consumed");
    await fs.mkdir(archived);
    const destination = path.join(archived, `${snapshot.snapshotId}.json`);
    await fs.writeFile(destination, "not the original snapshot");
    game.reset();
    let rejected = false;
    try { await recoverPendingGame(store, game, null); }
    catch { rejected = true; }
    assert(rejected, "conflicting archive must block recovery");
    assertEqual((await store.readPending())?.snapshotId, snapshot.snapshotId,
      "original pending evidence retained");
    assert(!game.announced, "partially restored state must be hidden");
  });
});

test("Recovery store rejects existing pending and partial/unreadable snapshots without overwriting", async () => {
  await withStore(async (store, directory) => {
    const snapshot = createGameSnapshot(setup(3));
    await store.save(snapshot);
    let failed = false;
    try { await store.save(createGameSnapshot(GameInstance.getInstance())); } catch { failed = true; }
    assert(failed, "pending snapshot cannot be overwritten");
    assertEqual((await store.readPending())?.snapshotId, snapshot.snapshotId, "original pending remains");
    await fs.writeFile(store.pendingPath, "{incomplete");
    failed = false;
    try { await store.readPending(); } catch { failed = true; }
    assert(failed, "corrupt pending must not be loaded");
    assertEqual((await fs.readdir(directory)).filter((n) => n.startsWith(".writing")).length, 0, "temporary files cleaned");
  });
});

test("Recovery avoids partial publication and original game survives an IO failure", async () => {
  await withStore(async (store, directory) => {
    const game = setup();
    const pathFile = path.join(directory, "not-a-directory");
    await fs.writeFile(pathFile, "blocking file");
    const badStore = new GameSnapshotStore(pathFile);
    let failed = false;
    try { await GameRecoveryCoordinator.capture(game, badStore); } catch { failed = true; }
    assert(failed, "filesystem unavailable");
    assert(!GameRecoveryCoordinator.isFrozen(), "unfrozen when no pending snapshot published");
    assertEqual(game.getRegisteredPlayerCount(), 20, "no in-memory loss");
  });
});

test("Recovery refuses restart if an untracked mutation changes game while writing", async () => {
  await withStore(async (store) => {
    const game = setup(3);
    const originalSave = store.save.bind(store);
    store.save = async (snapshot) => {
      await originalSave(snapshot);
      game.organiser = "changed-during-disk-write";
    };
    let failed = false;
    try { await GameRecoveryCoordinator.capture(game, store); }
    catch (error) { failed = /Game data changed/.test(String(error)); }
    assert(failed, "post-write state drift aborts restart");
    assert(GameRecoveryCoordinator.isFrozen(), "published pending file blocks further operations");
    assert((await store.readPending()) !== null, "ambiguous snapshot retained for review");
  });
});

test("Recovery capture waits for active operations and fails boundedly for a stuck operation", async () => {
  await withStore(async (store) => {
    const game = setup();
    const done = GameRecoveryCoordinator.enterOperation();
    assert(done, "operation registered");
    let failed = false;
    try { await GameRecoveryCoordinator.capture(game, store, undefined, 20); }
    catch (error) { failed = /In-flight/.test(String(error)); }
    assert(failed, "timed-out capture rejected");
    done?.();
    assert(!GameRecoveryCoordinator.isFrozen(), "gate released after failure");
    assertEqual(await store.readPending(), null, "nothing published");
  });
});

test("Recovery capture drains a queued operation, rejects competing capture, and fences timers", async () => {
  await withStore(async (store) => {
    const game = setup();
    const done = GameRecoveryCoordinator.enterOperation();
    assert(done, "active operation");
    const captured = GameRecoveryCoordinator.capture(game, store, undefined, 1000);
    let competingFailed = false;
    try { await GameRecoveryCoordinator.capture(game, store); } catch { competingFailed = true; }
    assert(competingFailed, "concurrent capture denied");
    done?.();
    await captured;
    assert(GameRecoveryCoordinator.isFrozen(), "gate remains closed until exit");
    assertEqual(GameRecoveryCoordinator.enterOperation(), null, "new operations denied");
    let fired = 0;
    Scheduler.schedule("snapshot-test", () => { fired++; }, new Date(Date.now() + 20));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEqual(fired, 0, "old callback cannot mutate snapshot");
    Scheduler.cancel("snapshot-test");
  });
});

test("Scheduled deadlines deferred during a failed snapshot execute once after abort", async () => {
  await withStore(async (store) => {
    const game = setup(4);
    let releaseSave!: () => void;
    let enteredSave!: () => void;
    const saving = new Promise<void>((resolve) => { enteredSave = resolve; });
    const pause = new Promise<void>((resolve) => { releaseSave = resolve; });
    store.save = async () => {
      enteredSave();
      await pause;
      throw new Error("disk unavailable");
    };
    let executions = 0;
    const capture = GameRecoveryCoordinator.capture(game, store);
    await saving;
    Scheduler.schedule("abort-deadline", () => { executions++; },
      new Date(Date.now() + 15));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assertEqual(executions, 0, "timer must not mutate game during the snapshot");
    releaseSave();
    let rejected = false;
    try { await capture; } catch { rejected = true; }
    assert(rejected, "disk failure cancels restart");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEqual(executions, 1, "due task resumes after the failed capture");
    assert(!GameRecoveryCoordinator.isFrozen(), "ordinary operations reopened");
  });
});

test("Interrupted temporary snapshot publication blocks startup without losing evidence", async () => {
  await withStore(async (store, directory) => {
    const orphanPath = path.join(directory, ".writing-interrupted");
    await fs.writeFile(orphanPath, '{"schemaVersion":1');
    const game = setup();
    game.reset();
    let failed = false;
    try {
      await recoverPendingGame(store, game, null);
    } catch (error) {
      failed = /Interrupted active-game snapshot/.test(String(error));
    }
    assert(failed, "incomplete publication must not silently start empty");
    assertEqual(await store.readPending(), null, "incomplete file never treated as pending");
    assert((await fs.readFile(orphanPath, "utf8")).includes("schemaVersion"), "forensic file retained");
  });
});

test("Recovery startup rejects corrupt or incompatible pending files and leaves them intact", async () => {
  await withStore(async (store) => {
    const original = createGameSnapshot(setup());
    await store.save(original);
    GameInstance.getInstance().reset();
    let failed = false;
    try { await recoverPendingGame(store, GameInstance.getInstance(), "pending match cleanup"); }
    catch { failed = true; }
    assert(failed, "match cleanup gate conflicts with snapshot");
    assertEqual((await store.readPending())?.snapshotId, original.snapshotId, "forensic artifact retained");
    const invalid = { ...original, schemaVersion: 9 };
    await fs.writeFile(store.pendingPath, JSON.stringify(invalid));
    failed = false;
    try { await recoverPendingGame(store, GameInstance.getInstance(), null); }
    catch { failed = true; }
    assert(failed, "incompatible version");
    assert((await fs.readFile(store.pendingPath, "utf8")).includes('"schemaVersion":9'), "still retained");
  });
});

test("Recovery failed partial installation resets memory but preserves pending file", async () => {
  await withStore(async (store) => {
    const game = setup();
    const snapshot = createGameSnapshot(game);
    await store.save(snapshot);
    game.reset();
    const original = game.restoreRecoveryMetadata;
    (game as any).restoreRecoveryMetadata = () => { throw new Error("injected restore failure"); };
    let failed = false;
    try { await recoverPendingGame(store, game, null); } catch { failed = true; }
    finally { (game as any).restoreRecoveryMetadata = original; }
    assert(failed, "restore failure injected");
    assert(!game.announced && game.getRegisteredPlayerCount() === 0, "partial game never visible");
    assertEqual((await store.readPending())?.snapshotId, snapshot.snapshotId, "pending retained");
  });
});

test("Recovery rejects a different deployment and active conflicting lifecycle", () => {
  const game = setup();
  const snapshot = createGameSnapshot(game);
  game.reset();
  const altered = structuredClone(snapshot);
  altered.environment.registrationChannelId = "wrong-channel";
  let failed = false;
  try { restoreGameSnapshot(digest(altered), game); } catch { failed = true; }
  assert(failed && !game.announced, "different deployment rejected");
  game.gameId = "unrelated-current-game";
  failed = false;
  try { restoreGameSnapshot(snapshot, game); } catch { failed = true; }
  assert(failed, "existing lifecycle prevents replacement");
  game.reset();
});

test("Recovery captures the entire roster operation queue after its pending mutation commits", async () => {
  await withStore(async (store) => {
    const game = setup(2);
    const command = new TeamCommand();
    let resolveWork!: () => void;
    const pending = new Promise<void>((resolve) => { resolveWork = resolve; });
    const task = command.runRosterOperation(async () => {
      await pending;
      game.teams.UNDECIDED.push(player("999"));
    });
    const capture = GameRecoveryCoordinator.capture(game, store, command, 500);
    resolveWork();
    await task;
    const snapshot = await capture;
    assertEqual(snapshot.game.teams.UNDECIDED.length, 1, "committed roster included");
    assertEqual(snapshot.game.teams.UNDECIDED[0].discordSnowflake, "999", "pending registration retained");
  });
});

test("Normal /team list resolves the recovered singleton and displays its captains", async () => {
  await withStore(async (store) => {
    const game = setup(20);
    await store.save(createGameSnapshot(game));
    game.reset();
    await recoverPendingGame(store, game, null);
    const guild = new FakeGuild() as any;
    const member = new FakeGuildMember("reviewer");
    guild.addMember(member);
    const interaction = createChatInputInteraction("reviewer", {
      guild, member, commandName: "team", subcommand: "list",
    });
    const command = new TeamCommand();
    await command.execute(interaction);
    const reply = interaction.replies.find((entry: any) => entry.type === "editReply")?.payload;
    assert(reply?.embeds?.length === 1, "normal team command used restored game");
    const fields = reply.embeds[0].data.fields;
    assert(fields.some((field: any) => String(field.value).includes("IGN100")), "red captain appears");
    assert(fields.some((field: any) => String(field.value).includes("IGN101")), "blue captain appears");
    assert(String(reply.content).includes("Recovered game"), "paused workflow diagnostics available");
  });
});

test("Recovered game can be reset and a subsequent announcement uses a new lifecycle", async () => {
  await withStore(async (store) => {
    const game = setup(5);
    const oldId = game.gameId;
    await store.save(createGameSnapshot(game));
    game.reset();
    await recoverPendingGame(store, game, null);
    assertEqual(game.getRegisteredPlayerCount(), 5, "restored");
    game.reset();
    await MatchRecoveryGate.inspectPending(async () => []);
    game.beginConfirmedAnnouncement();
    assert(game.gameId !== oldId, "new identity after reset");
    assertEqual(game.getRegisteredPlayerCount(), 0, "old roster does not leak");
    assertEqual(game.recoveryDraftProgress, undefined, "old paused workflow cleared");
  });
});

test("Old map vote callbacks cannot mutate a subsequent game", () => {
  const game = setup(2);
  game.startMapVote([AnniMap.ARID1V1]);
  const oldManager = game.mapVoteManager!;
  game.reset();
  game.announced = true;
  game.gameId = game.getLifecycleToken();
  oldManager.emit("pollEnd", AnniMap.ANDORRA1V1);
  assertEqual(game.settings.map, undefined, "obsolete map vote rejected");
  game.reset();
});

test("Recovery Discord reference re-fetch is read-only, missing and timed-out messages remain unverified", async () => {
  const bot = Object.create(TeamsBot.prototype) as any;
  let fetchCount = 0;
  bot.client = { channels: { fetch: async (_id: string) => ({
    messages: { fetch: async (id: string) => { fetchCount++; return { id, channelId: "channel" }; } },
  }) } };
  const ref = { id: "existing", channelId: "channel" };
  const found = await bot.fetchRecoveryMessage(ref, 15);
  assertEqual(found?.id, "existing", "original message returned");
  assertEqual(fetchCount, 1, "only a fetch; no message creation");
  bot.client = { channels: { fetch: async () => { throw new Error("Unknown Message"); } } };
  assertEqual(await bot.fetchRecoveryMessage(ref, 15), null, "missing fetch is not re-created");
  bot.client = { channels: { fetch: () => new Promise(() => {}) } };
  assertEqual(await bot.fetchRecoveryMessage(ref, 15), null, "timeout is inconclusive");
});

test("Full preserve-restart command snapshots then startup restores the same 20-player game", async () => {
  await withStore(async (store) => {
    const game = setup();
    const originalId = game.gameId;
    const originalHasRole = PermissionsUtil.hasRole;
    (PermissionsUtil as any).hasRole = () => true;
    const command = new RestartCommand(() => store);
    let restarts = 0;
    command.restartBot = () => { restarts++; };
    const replies: any[] = [];
    const chat = {
      member: {}, user: { id: "organiser" }, guildId: "guild",
      options: { getBoolean: () => true },
      reply: async (payload: any) => { replies.push(payload); },
    } as any;
    try {
      await command.execute(chat);
      const buttonId = replies[0].components[0].components[0].data.custom_id;
      const button = {
        customId: buttonId, member: {}, user: { id: "organiser" },
        guildId: "guild", update: async () => {}, editReply: async () => {},
        reply: async () => { throw new Error("unexpected denial"); },
      } as any;
      await command.handleButtonPress(button);
      assertEqual(restarts, 1, "restart requested only after durable snapshot");
      assertEqual((await store.readPending())?.gameId, originalId, "pending file validated");
      game.reset(); // simulate a fresh process's empty singleton
      GameRecoveryCoordinator.resetForTests();
      const recovered = await recoverPendingGame(store, game, null);
      assertEqual(recovered?.gameId, originalId, "same original game");
      assertEqual(game.getRegisteredPlayerCount(), 20, "all registrations survive restart");
      assertEqual(game.getCaptainOfTeam("RED")?.discordSnowflake, "100", "red captain preserved");
      assertEqual(game.getCaptainOfTeam("BLUE")?.discordSnowflake, "101", "blue captain preserved");
      assertEqual(game.startTime?.toISOString(), "2026-11-02T20:00:00.000Z", "start time");
      assertEqual(game.settings.organiserBannedClasses[0], AnniClass.ACROBAT, "bans");
    } finally {
      (PermissionsUtil as any).hasRole = originalHasRole;
    }
  });
});

test("Preserved restart refuses to exit when its actual snapshot file cannot be created", async () => {
  await withStore(async (_store, directory) => {
    const game = setup(6);
    const invalidDirectory = path.join(directory, "occupied-by-a-file");
    await fs.writeFile(invalidDirectory, "not a directory");
    const originalHasRole = PermissionsUtil.hasRole;
    (PermissionsUtil as any).hasRole = () => true;
    const command = new RestartCommand(() => new GameSnapshotStore(invalidDirectory));
    let exits = 0;
    command.restartBot = () => { exits++; };
    const replies: any[] = [];
    try {
      await command.execute({
        member: {}, user: { id: "organiser" }, guildId: "guild",
        options: { getBoolean: () => true },
        reply: async (payload: any) => { replies.push(payload); },
      } as any);
      const button = {
        customId: replies[0].components[0].components[0].data.custom_id,
        member: {}, user: { id: "organiser" }, guildId: "guild",
        update: async () => {},
        editReply: async () => {},
      } as any;
      await command.handleButtonPress(button);
      assertEqual(exits, 0, "filesystem failure must not restart");
      assertEqual(game.getRegisteredPlayerCount(), 6, "registrations retained in memory");
      assert(!GameRecoveryCoordinator.isFrozen(), "game operations released when nothing published");
    } finally {
      (PermissionsUtil as any).hasRole = originalHasRole;
    }
  });
});

test("Restart confirmation rejects a different user without exiting", async () => {
  const originalHasRole = PermissionsUtil.hasRole;
  (PermissionsUtil as any).hasRole = () => true;
  const command = new RestartCommand();
  let exits = 0;
  command.restartBot = () => { exits++; };
  const replies: any[] = [];
  try {
    GameRecoveryCoordinator.resetForTests();
    await command.execute({
      member: {}, user: { id: "original" }, guildId: "guild",
      options: { getBoolean: () => false },
      reply: async (payload: any) => { replies.push(payload); },
    } as any);
    let rejection = "";
    await command.handleButtonPress({
      customId: replies[0].components[0].components[0].data.custom_id,
      member: {}, user: { id: "other" }, guildId: "guild",
      reply: async (payload: any) => { rejection = payload.content; },
    } as any);
    assert(rejection.includes("belongs to another"), "different organiser denied");
    assertEqual(exits, 0, "no restart");
  } finally {
    (PermissionsUtil as any).hasRole = originalHasRole;
  }
});

test("Recovered game blocks stale announcement confirmation and a fresh /announce start", async () => {
  const game = setup(4);
  const originalId = game.gameId;
  const command = new AnnouncementCommand();
  let denial = "";
  await command.handleButtonPress({
    customId: "announcement-confirm-ping",
    reply: async (payload: any) => { denial = payload.content; },
  } as any);
  assert(denial.includes("existing announcement"), "stale confirmation rejected without re-sending");
  let startReply = "";
  await (command as any).handleAnnouncementStart({
    deferReply: async () => {},
    editReply: async (text: string) => { startReply = text; },
  });
  assert(startReply.includes("already announced"), "new announcement rejected");
  assertEqual(game.gameId, originalId, "original lifecycle retained");
  assertEqual(game.getRegisteredPlayerCount(), 4, "registrations unchanged");
  game.reset();
});

test("Default restart still exits through existing method, preserve failure does not exit", async () => {
  const originalHasRole = PermissionsUtil.hasRole;
  (PermissionsUtil as any).hasRole = () => true;
  const command = new RestartCommand();
  let restarts = 0;
  command.restartBot = () => { restarts++; };
  function request(preserve: boolean) {
    const replies: any[] = [];
    const chat = {
      member: {}, user: { id: "organiser" }, guildId: "guild",
      options: { getBoolean: () => preserve },
      reply: async (payload: any) => { replies.push(payload); },
    } as any;
    return { chat, replies };
  }
  try {
    GameRecoveryCoordinator.resetForTests();
    const normal = request(false);
    await command.execute(normal.chat);
    const normalId = normal.replies[0].components[0].components[0].data.custom_id;
    const normalBtn = {
      customId: normalId, member: {}, user: { id: "organiser" },
      guildId: "guild", update: async () => {},
      editReply: async () => {}, reply: async () => { throw new Error("unexpected denial"); },
    } as any;
    await command.handleButtonPress(normalBtn);
    assertEqual(restarts, 1, "default restart unchanged");
    const preserved = request(true);
    await command.execute(preserved.chat);
    const preserveBtn = { ...normalBtn, customId: preserved.replies[0].components[0].components[0].data.custom_id };
    setup(0);
    GameInstance.getInstance().announced = false;
    await command.handleButtonPress(preserveBtn);
    assertEqual(restarts, 1, "snapshot failure must not restart");
  } finally {
    (PermissionsUtil as any).hasRole = originalHasRole;
    GameInstance.getInstance().reset();
    GameRecoveryCoordinator.resetForTests();
  }
});
