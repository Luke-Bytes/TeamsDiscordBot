import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AnniClass, AnniMap } from "@prisma/client";
import { GameInstance } from "../database/GameInstance";
import { PlayerInstance } from "../database/PlayerInstance";
import { ConfigManager } from "../ConfigManager";
import { TeamPlanRecord } from "../util/PlanUtil";
import type TeamCommand from "../commands/TeamCommand";
import { DraftTeamPickingSession } from "./teams/DraftTeamPickingSession";
import { RandomTeamPickingSession } from "./teams/RandomTeamPickingSession";

type TeamKey = "RED" | "BLUE" | "UNDECIDED";
type PlayerRecord = Pick<PlayerInstance,
  "playerId" | "discordSnowflake" | "minecraftAccounts" | "primaryMinecraftAccount" |
  "latestIGN" | "ignUsed" | "captain" | "draftSlotPlacement" | "elo" | "wins" |
  "losses" | "winStreak" | "loseStreak" | "biggestWinStreak" | "biggestLosingStreak">;

type SerializedPlayer = Omit<PlayerRecord, "primaryMinecraftAccount" | "latestIGN" | "ignUsed" | "captain" | "draftSlotPlacement"> & {
  primaryMinecraftAccount: string | null;
  latestIGN: string | null;
  ignUsed: string | null;
  captain: boolean;
  draftSlotPlacement: number | null;
};

type SerializedPlan = Omit<TeamPlanRecord, "capturedAt" | "raw"> & {
  raw: string | null;
  capturedAt: string;
};

type GameState = {
  announced: true;
  startTime: string;
  organiser: string | null;
  host: string | null;
  teams: Record<TeamKey, SerializedPlayer[]>;
  lateSignups: string[];
  captainNominations: string[];
  lastRegisteredSnowflake: string | null;
  teamsDecidedBy: GameInstance["teamsDecidedBy"] | null;
  settings: {
    organiserBannedClasses: AnniClass[];
    sharedCaptainBannedClasses: AnniClass[];
    nonSharedCaptainBannedClasses: { RED: AnniClass[]; BLUE: AnniClass[] };
    map: AnniMap | null;
    modifiers: { category: string; name: string }[];
    delayedBan: number;
  };
  classBanMode: "shared" | "opponentOnly" | null;
  classBanLimit: number;
  captainBanCounts: [string, number][];
  captainBanLocked: string[];
  classBansAnnounced: boolean;
  isDoubleElo: boolean;
  isRelaxedSeason: boolean;
  noElo: boolean;
  pickOtherTeamsSupportRoles: boolean;
  modifierMode: GameInstance["modifierMode"];
  redTeamPlan: SerializedPlan | null;
  blueTeamPlan: SerializedPlan | null;
};

type WorkflowState = {
  paused: string[];
  draft: null | {
    mode: "draft" | "snake";
    turn: "RED" | "BLUE" | null;
    proposedTeams: Record<TeamKey, string[]>;
    lateSignups: string[];
    finishedPicking: boolean;
  };
  preview: null | { proposedTeams: Record<TeamKey, string[]> };
  mapVote: null | { maps: AnniMap[]; messageId: string | null; channelId: string | null };
  minerushVote: null | { messageId: string | null; channelId: string | null };
  announcementMessage: null | { id: string; channelId: string };
  announcementPingMessage: null | { id: string; channelId: string };
  announcementPreviewMessage: null | { id: string; channelId: string };
};

export type GameSnapshot = {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  gameId: string;
  lifecycleToken: string;
  environment: { announcementChannelId: string; registrationChannelId: string; guildId: string | null };
  game: GameState;
  workflows: WorkflowState;
  checksum: string;
};

const dir = () => path.resolve(process.cwd(), ".runtime", "active-game-recovery");
export const pendingGameSnapshotPath = () => path.join(dir(), "pending.json");
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid active-game snapshot: ${message}`);
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableStr = (value: unknown) => value === null || str(value);
const validDate = (value: unknown): value is string =>
  str(value) && !Number.isNaN(new Date(value).getTime()) && new Date(value).toISOString() === value;
const listOf = (value: unknown, check: (value: unknown) => boolean): value is unknown[] =>
  Array.isArray(value) && value.every(check);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const teamKeys: TeamKey[] = ["RED", "BLUE", "UNDECIDED"];
const playerKeys = ["playerId", "discordSnowflake", "minecraftAccounts", "primaryMinecraftAccount", "latestIGN", "ignUsed", "captain", "draftSlotPlacement", "elo", "wins", "losses", "winStreak", "loseStreak", "biggestWinStreak", "biggestLosingStreak"];
const playersToIds = (teams: Record<TeamKey, PlayerInstance[]>): Record<TeamKey, string[]> => ({
  RED: teams.RED.map((p) => p.discordSnowflake),
  BLUE: teams.BLUE.map((p) => p.discordSnowflake),
  UNDECIDED: teams.UNDECIDED.map((p) => p.discordSnowflake),
});
const messageRef = (message: { id: string; channelId: string } | undefined) =>
  message ? { id: message.id, channelId: message.channelId } : null;
const serializePlan = (plan?: TeamPlanRecord): SerializedPlan | null =>
  plan ? { midBlocks: plan.midBlocks, gamePlan: plan.gamePlan, raw: plan.raw ?? null, source: plan.source, capturedAt: plan.capturedAt.toISOString() } : null;
const deserializePlan = (plan: SerializedPlan | null): TeamPlanRecord | undefined =>
  plan ? { ...plan, capturedAt: new Date(plan.capturedAt) } : undefined;
const serializePlayer = (p: PlayerInstance): SerializedPlayer => ({
  playerId: p.playerId, discordSnowflake: p.discordSnowflake,
  minecraftAccounts: [...p.minecraftAccounts], primaryMinecraftAccount: p.primaryMinecraftAccount ?? null,
  latestIGN: p.latestIGN ?? null, ignUsed: p.ignUsed ?? null, captain: p.captain === true,
  draftSlotPlacement: p.draftSlotPlacement ?? null,
  elo: p.elo, wins: p.wins, losses: p.losses, winStreak: p.winStreak,
  loseStreak: p.loseStreak, biggestWinStreak: p.biggestWinStreak, biggestLosingStreak: p.biggestLosingStreak,
});

export function createGameSnapshot(game: GameInstance, teamCommand?: TeamCommand): GameSnapshot {
  requireCondition(game.announced && !!game.gameId && !!game.startTime, "no complete announced game");
  requireCondition(game.getGameStartStatus() === "idle" && !game.isFinished &&
    !game.isRestarting && !game.gameWinner && !game.endTime, "game is starting, started or finished");
  requireCondition(game.gameId === game.getLifecycleToken(), "game and lifecycle identity differ");
  const metadata = game.exportRecoveryMetadata();
  const session = teamCommand?.teamPickingSession;
  const draft = session instanceof DraftTeamPickingSession && session.state === "inProgress"
    ? session.exportRecoveryProgress() : null;
  const preview = session instanceof RandomTeamPickingSession && session.state === "inProgress"
    ? { proposedTeams: playersToIds(session.proposedTeams) } : null;
  const paused = [
    ...(draft ? ["draft: uncommitted picks saved; manual team-picking review required"] : []),
    ...(preview ? ["team preview: unconfirmed teams not applied"] : []),
    ...(game.mapVoteManager ? ["map vote: original Discord poll not automatically finalised"] : []),
    ...(game.minerushVoteManager ? ["minerush vote: original poll not automatically finalised"] : []),
    "automatic captain, class-ban and draft timers: not rearmed; review deadlines",
    "captain plan DM collectors and game-feed updaters: not resumed",
  ];
  const config = ConfigManager.getConfig();
  const payload = {
    schemaVersion: 1 as const, snapshotId: randomUUID(), createdAt: new Date().toISOString(),
    gameId: game.gameId!, lifecycleToken: game.getLifecycleToken(),
    environment: { announcementChannelId: config.channels.announcements,
      registrationChannelId: config.channels.registration,
      guildId: config.dev.enabled ? config.dev.guildId : null },
    game: {
      announced: true as const, startTime: game.startTime!.toISOString(),
      organiser: game.organiser ?? null, host: game.host ?? null,
      teams: { RED: game.teams.RED.map(serializePlayer), BLUE: game.teams.BLUE.map(serializePlayer),
        UNDECIDED: game.teams.UNDECIDED.map(serializePlayer) },
      lateSignups: [...game.lateSignups], captainNominations: [...game.captainNominations],
      lastRegisteredSnowflake: game.lastRegisteredSnowflake ?? null,
      teamsDecidedBy: game.teamsDecidedBy ?? null,
      settings: {
        organiserBannedClasses: [...game.settings.organiserBannedClasses],
        sharedCaptainBannedClasses: [...game.settings.sharedCaptainBannedClasses],
        nonSharedCaptainBannedClasses: {
          RED: [...game.settings.nonSharedCaptainBannedClasses.RED],
          BLUE: [...game.settings.nonSharedCaptainBannedClasses.BLUE],
        },
        map: game.settings.map ?? null, modifiers: game.settings.modifiers.map((m) => ({ ...m })),
        delayedBan: game.settings.delayedBan,
      },
      classBanMode: game.classBanMode, classBanLimit: game.classBanLimit,
      ...metadata, isDoubleElo: game.isDoubleElo, isRelaxedSeason: game.isRelaxedSeason, noElo: game.noElo,
      pickOtherTeamsSupportRoles: game.pickOtherTeamsSupportRoles, modifierMode: game.modifierMode,
      redTeamPlan: serializePlan(game.redTeamPlan), blueTeamPlan: serializePlan(game.blueTeamPlan),
    },
    workflows: {
      paused, draft, preview,
      mapVote: game.mapVoteManager ? {
        maps: [...game.mapVoteManager.maps], ...({ messageId: game.mapVoteManager.pollMessage?.id ?? null,
          channelId: game.mapVoteManager.pollMessage?.channelId ?? null }),
      } : null,
      minerushVote: game.minerushVoteManager ? {
        messageId: game.minerushVoteManager.pollMessage?.id ?? null,
        channelId: game.minerushVoteManager.pollMessage?.channelId ?? null,
      } : null,
      announcementMessage: messageRef(game.announcementMessage),
      announcementPingMessage: messageRef(game.announcementPingMessage),
      announcementPreviewMessage: messageRef(game.announcementPreviewMessage),
    },
  };
  const snapshot: GameSnapshot = { ...payload, checksum: sha(payload) };
  validateGameSnapshot(snapshot);
  return snapshot;
}

export function validateGameSnapshot(input: unknown): asserts input is GameSnapshot {
  requireCondition(record(input) && keys(input, [
    "schemaVersion", "snapshotId", "createdAt", "gameId", "lifecycleToken",
    "environment", "game", "workflows", "checksum",
  ]), "root fields");
  const { checksum, ...payload } = input;
  requireCondition(input.schemaVersion === 1, "unsupported schema version");
  requireCondition(str(input.snapshotId) && validDate(input.createdAt) &&
    str(input.gameId) && input.gameId === input.lifecycleToken, "identity or createdAt");
  requireCondition(typeof checksum === "string" && /^[a-f0-9]{64}$/.test(checksum) &&
    sha(payload) === checksum, "checksum mismatch");
  requireCondition(record(input.environment) && keys(input.environment,
    ["announcementChannelId", "registrationChannelId", "guildId"]) &&
    str(input.environment.announcementChannelId) && str(input.environment.registrationChannelId) &&
    nullableStr(input.environment.guildId), "environment");
  const g = input.game;
  requireCondition(record(g) && keys(g, [
    "announced", "startTime", "organiser", "host", "teams", "lateSignups", "captainNominations",
    "lastRegisteredSnowflake", "teamsDecidedBy", "settings", "classBanMode", "classBanLimit",
    "captainBanCounts", "captainBanLocked", "classBansAnnounced", "isDoubleElo",
    "isRelaxedSeason", "noElo", "pickOtherTeamsSupportRoles", "modifierMode",
    "redTeamPlan", "blueTeamPlan",
  ]) && g.announced === true && validDate(g.startTime) &&
    nullableStr(g.organiser) && nullableStr(g.host) && nullableStr(g.lastRegisteredSnowflake), "game fields");
  requireCondition(record(g.teams) && keys(g.teams, teamKeys), "teams");
  const ids = new Set<string>();
  for (const team of teamKeys) {
    requireCondition(Array.isArray(g.teams[team]), `${team} team`);
    for (const p of g.teams[team]) {
      requireCondition(record(p) && keys(p, playerKeys) && str(p.playerId) &&
        str(p.discordSnowflake) && !ids.has(p.discordSnowflake) &&
        listOf(p.minecraftAccounts, str) && nullableStr(p.primaryMinecraftAccount) &&
        nullableStr(p.latestIGN) && nullableStr(p.ignUsed) && typeof p.captain === "boolean" &&
        (p.draftSlotPlacement === null || Number.isInteger(p.draftSlotPlacement)) &&
        ["elo", "wins", "losses", "winStreak", "loseStreak", "biggestWinStreak", "biggestLosingStreak"]
          .every((key) => typeof p[key] === "number" && Number.isFinite(p[key])), "player data or duplicate");
      if (p.captain) requireCondition(team !== "UNDECIDED", "undecided captain");
      ids.add(p.discordSnowflake);
    }
  }
  const idList = (value: unknown, mustBeRegistered = true) =>
    listOf(value, str) && new Set(value).size === value.length &&
    (!mustBeRegistered || value.every((id) => ids.has(id as string)));
  requireCondition(idList(g.lateSignups) && idList(g.captainNominations) &&
    (g.lastRegisteredSnowflake === null || ids.has(g.lastRegisteredSnowflake)), "registration references");
  requireCondition(g.teamsDecidedBy === null || ["DRAFT", "SNAKE_DRAFT", "RANDOMISED", "ELO", "BALANCE"].includes(g.teamsDecidedBy as string), "selection method");
  requireCondition(g.classBanMode === null || ["shared", "opponentOnly"].includes(g.classBanMode as string), "class ban mode");
  requireCondition(typeof g.classBanLimit === "number" && Number.isSafeInteger(g.classBanLimit) && g.classBanLimit >= 0 &&
    typeof g.classBansAnnounced === "boolean" &&
    ["isDoubleElo", "isRelaxedSeason", "noElo", "pickOtherTeamsSupportRoles"].every((key) => typeof g[key] === "boolean") &&
    ["custom", "randomised", "default", "none"].includes(g.modifierMode as string), "flags");
  requireCondition(record(g.settings) && keys(g.settings, [
    "organiserBannedClasses", "sharedCaptainBannedClasses", "nonSharedCaptainBannedClasses",
    "map", "modifiers", "delayedBan",
  ]), "settings");
  const s = g.settings;
  const banList = (v: unknown) => listOf(v, (x) => Object.values(AnniClass).includes(x as AnniClass));
  requireCondition(banList(s.organiserBannedClasses) && banList(s.sharedCaptainBannedClasses) &&
    record(s.nonSharedCaptainBannedClasses) && keys(s.nonSharedCaptainBannedClasses, ["RED", "BLUE"]) &&
    banList(s.nonSharedCaptainBannedClasses.RED) && banList(s.nonSharedCaptainBannedClasses.BLUE) &&
    (s.map === null || Object.values(AnniMap).includes(s.map as AnniMap)) &&
    listOf(s.modifiers, (v) => record(v) && keys(v, ["category", "name"]) && str(v.category) && str(v.name)) &&
    Number.isSafeInteger(s.delayedBan) && (s.delayedBan as number) >= 0, "game settings");
  requireCondition(listOf(g.captainBanCounts, (entry) => Array.isArray(entry) && entry.length === 2 &&
    str(entry[0]) && ids.has(entry[0]) && Number.isSafeInteger(entry[1]) && entry[1] >= 0) &&
    idList(g.captainBanLocked), "ban counters and locks");
  for (const name of ["redTeamPlan", "blueTeamPlan"] as const) {
    const plan = g[name];
    requireCondition(plan === null || (record(plan) &&
      keys(plan, ["midBlocks", "gamePlan", "raw", "source", "capturedAt"]) &&
      [plan.midBlocks, plan.gamePlan, plan.raw].every(nullableStr) &&
      ["DM", "CHANNEL", "MIXED", "NONE"].includes(plan.source as string) &&
      validDate(plan.capturedAt)), name);
  }
  const wf = input.workflows;
  requireCondition(record(wf) && keys(wf, [
    "paused", "draft", "preview", "mapVote", "minerushVote",
    "announcementMessage", "announcementPingMessage", "announcementPreviewMessage",
  ]) && listOf(wf.paused, str), "workflows");
  const refs = (v: unknown) => record(v) && keys(v, ["id", "channelId"]) && str(v.id) && str(v.channelId);
  for (const name of ["announcementMessage", "announcementPingMessage", "announcementPreviewMessage"]) {
    requireCondition(wf[name] === null || refs(wf[name]), name);
  }
  // A provisional picking layout must not have the same player in two teams.
  // It may omit late arrivals that are separately recorded for review.
  const idsByTeam = (v: unknown) => record(v) && keys(v, teamKeys) &&
    teamKeys.every((team) => idList(v[team])) &&
    new Set(teamKeys.flatMap((team) => v[team] as string[])).size ===
      teamKeys.reduce((count, team) => count + (v[team] as string[]).length, 0);
  requireCondition(wf.draft === null || (record(wf.draft) &&
    keys(wf.draft, ["mode", "turn", "proposedTeams", "lateSignups", "finishedPicking"]) &&
    ["draft", "snake"].includes(wf.draft.mode as string) &&
    (wf.draft.turn === null || ["RED", "BLUE"].includes(wf.draft.turn as string)) &&
    idsByTeam(wf.draft.proposedTeams) && idList(wf.draft.lateSignups) &&
    typeof wf.draft.finishedPicking === "boolean"), "draft");
  requireCondition(wf.preview === null || (record(wf.preview) &&
    keys(wf.preview, ["proposedTeams"]) && idsByTeam(wf.preview.proposedTeams)), "preview");
  requireCondition(wf.mapVote === null || (record(wf.mapVote) &&
    keys(wf.mapVote, ["maps", "messageId", "channelId"]) &&
    listOf(wf.mapVote.maps, (m) => Object.values(AnniMap).includes(m as AnniMap)) &&
    nullableStr(wf.mapVote.messageId) && nullableStr(wf.mapVote.channelId)), "map vote");
  requireCondition(wf.minerushVote === null || (record(wf.minerushVote) &&
    keys(wf.minerushVote, ["messageId", "channelId"]) &&
    nullableStr(wf.minerushVote.messageId) && nullableStr(wf.minerushVote.channelId)), "minerush vote");
}

export function restoreGameSnapshot(snapshot: GameSnapshot, game: GameInstance): void {
  validateGameSnapshot(snapshot);
  const config = ConfigManager.getConfig();
  requireCondition(snapshot.environment.announcementChannelId === config.channels.announcements &&
    snapshot.environment.registrationChannelId === config.channels.registration &&
    snapshot.environment.guildId === (config.dev.enabled ? config.dev.guildId : null),
    "deployment/channel identity differs");
  requireCondition(!game.announced && !game.gameId, "existing game conflicts with snapshot");
  const s = snapshot.game;
  const teams = Object.fromEntries(teamKeys.map((team) => [
    team, s.teams[team].map((p) => Object.assign(Object.create(PlayerInstance.prototype) as PlayerInstance, {
      ...p, primaryMinecraftAccount: p.primaryMinecraftAccount ?? undefined,
      latestIGN: p.latestIGN ?? undefined, ignUsed: p.ignUsed ?? undefined,
      draftSlotPlacement: p.draftSlotPlacement ?? undefined,
      minecraftAccounts: [...p.minecraftAccounts],
    })),
  ])) as GameInstance["teams"];
  // All checks and object allocation complete before mutating the singleton.
  game.teams = teams;
  game.announced = true;
  game.isFinished = false;
  game.startTime = new Date(s.startTime);
  game.organiser = s.organiser;
  game.host = s.host;
  game.teamsDecidedBy = s.teamsDecidedBy;
  game.lateSignups = new Set(s.lateSignups);
  game.captainNominations = new Set(s.captainNominations);
  game.lastRegisteredSnowflake = s.lastRegisteredSnowflake ?? undefined;
  game.settings = {
    ...s.settings, map: s.settings.map ?? undefined,
    organiserBannedClasses: [...s.settings.organiserBannedClasses],
    sharedCaptainBannedClasses: [...s.settings.sharedCaptainBannedClasses],
    nonSharedCaptainBannedClasses: {
      RED: [...s.settings.nonSharedCaptainBannedClasses.RED],
      BLUE: [...s.settings.nonSharedCaptainBannedClasses.BLUE],
    },
    modifiers: s.settings.modifiers.map((m) => ({ ...m })),
  };
  game.classBanMode = s.classBanMode;
  game.classBanLimit = s.classBanLimit;
  game.isDoubleElo = s.isDoubleElo;
  game.isRelaxedSeason = s.isRelaxedSeason;
  game.noElo = s.noElo;
  game.pickOtherTeamsSupportRoles = s.pickOtherTeamsSupportRoles;
  game.modifierMode = s.modifierMode;
  game.redTeamPlan = deserializePlan(s.redTeamPlan);
  game.blueTeamPlan = deserializePlan(s.blueTeamPlan);
  game.recoveryPausedWorkflows = [...snapshot.workflows.paused];
  game.recoveryDraftProgress = snapshot.workflows.draft ?? undefined;
  game.restoreRecoveryMetadata(snapshot.gameId, snapshot.lifecycleToken, {
    captainBanCounts: s.captainBanCounts,
    captainBanLocked: s.captainBanLocked,
    classBansAnnounced: s.classBansAnnounced,
  });
}

/** Install and consume with no external side effects. Failed install leaves pending untouched. */
export async function recoverPendingGame(
  store: GameSnapshotStore, game: GameInstance, matchRecoveryProblem: string | null
): Promise<GameSnapshot | null> {
  const snapshot = await store.readPending();
  if (!snapshot) {
    if (await store.hasIncompletePublication()) {
      throw new Error("Interrupted active-game snapshot publication detected; operator review required");
    }
    return null;
  }
  if (matchRecoveryProblem) throw new Error(`Completed-match recovery gate blocks active game restore: ${matchRecoveryProblem}`);
  const wasEmpty = !game.announced && !game.gameId;
  try {
    restoreGameSnapshot(snapshot, game);
    await store.consume(snapshot);
    return snapshot;
  } catch (error) {
    // The ID is installed last, so a failure during private-state import may
    // have changed the roster without yet setting gameId.
    if (wasEmpty && (game.announced || !!game.gameId)) game.reset();
    throw error;
  }
}

async function syncDirectory(directory: string) {
  // Some Windows filesystems do not permit opening directories for fsync.
  try {
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (e) {
    if (process.platform !== "win32") throw e;
  }
}

export class GameSnapshotStore {
  constructor(private readonly directory: string = dir()) {}
  get pendingPath() { return path.join(this.directory, "pending.json"); }
  async hasIncompletePublication(): Promise<boolean> {
    try {
      return (await fs.readdir(this.directory)).some((name) => name.startsWith(".writing-"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async readPending(): Promise<GameSnapshot | null> {
    let contents: string;
    try { contents = await fs.readFile(this.pendingPath, "utf8"); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const value: unknown = JSON.parse(contents);
    validateGameSnapshot(value);
    return value;
  }
  async save(snapshot: GameSnapshot): Promise<void> {
    validateGameSnapshot(snapshot);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await this.existsPending()) throw new Error("Unconsumed pending snapshot already exists");
    const temporary = path.join(this.directory, `.writing-${snapshot.snapshotId}`);
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(snapshot), "utf8");
        await file.sync();
      } finally { await file.close(); }
      // Atomic exclusive publication: unlike rename, link cannot replace pending.json.
      await fs.link(temporary, this.pendingPath);
      await syncDirectory(this.directory);
      const confirmed = await this.readPending();
      if (!confirmed || confirmed.snapshotId !== snapshot.snapshotId) {
        throw new Error("Snapshot verification failed after publication");
      }
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
  async existsPending() {
    try { await fs.stat(this.pendingPath); return true; }
    catch (e) { if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return false; throw e; }
  }
  async consume(snapshot: GameSnapshot): Promise<void> {
    // Never overwrite a previously consumed snapshot or consume a different pending file.
    const current = await this.readPending();
    if (!current || current.snapshotId !== snapshot.snapshotId) throw new Error("Pending snapshot changed");
    const archived = path.join(this.directory, "consumed");
    await fs.mkdir(archived, { recursive: true, mode: 0o700 });
    const destination = path.join(archived, `${snapshot.snapshotId}.json`);
    try {
      await fs.link(this.pendingPath, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A crash may have occurred after the archive link was published but
      // before pending.json was removed. Only complete the same consumption;
      // never replace an unrelated or corrupted archived file.
      const archivedContents = await fs.readFile(destination, "utf8");
      const archivedValue: unknown = JSON.parse(archivedContents);
      validateGameSnapshot(archivedValue);
      if (archivedValue.snapshotId !== snapshot.snapshotId ||
          archivedValue.checksum !== snapshot.checksum ||
          archivedContents !== JSON.stringify(current)) {
        throw new Error("Existing consumed snapshot conflicts with pending recovery");
      }
    }
    await syncDirectory(archived);
    // If the first process died immediately after publishing pending.json,
    // its same-snapshot .writing-* link can remain behind. Once the archive is
    // durable, remove that link *only* if its content exactly matches pending.
    // Any mismatched temporary artifact is preserved and blocks consumption.
    const interruptedWrite = path.join(this.directory, `.writing-${snapshot.snapshotId}`);
    try {
      const temporaryContents = await fs.readFile(interruptedWrite, "utf8");
      const pendingContents = await fs.readFile(this.pendingPath, "utf8");
      if (temporaryContents !== pendingContents) {
        throw new Error("Incomplete snapshot publication differs from pending recovery");
      }
      await fs.unlink(interruptedWrite);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.unlink(this.pendingPath);
    await syncDirectory(this.directory);
  }
}

/** Process-local barrier for the existing command and team queue. Not a distributed lock. */
export class GameRecoveryCoordinator {
  private static active = 0;
  private static frozen = false;
  private static claimed = false;
  private static startupReason: string | null = null;
  private static deferredOnAbort: Array<() => void> = [];

  /** A deadline reached during capture is retried only if capture definitively aborts. */
  static deferUntilCaptureAborts(callback: () => void): boolean {
    if (!this.claimed || !this.frozen) return false;
    this.deferredOnAbort.push(callback);
    return true;
  }

  static beginStartup() { this.startupReason = "Active-game snapshot recovery has not completed"; }
  static finishStartup(reason: string | null) { this.startupReason = reason; }
  static getBlockReason() { return this.startupReason ?? (this.frozen ? "Game snapshot/restart in progress" : null); }
  static isFrozen() { return this.frozen || this.startupReason !== null; }
  static enterOperation(): (() => void) | null {
    if (this.isFrozen()) return null;
    this.active++;
    let finished = false;
    return () => { if (!finished) { finished = true; this.active--; } };
  }
  static async capture(
    game: GameInstance, store = new GameSnapshotStore(), teamCommand?: TeamCommand,
    timeoutMs = 3000
  ): Promise<GameSnapshot> {
    if (this.claimed || this.isFrozen()) throw new Error("A restart/recovery operation is already in progress");
    this.claimed = true;
    this.frozen = true;
    const identity = game.getLifecycleToken();
    try {
      const deadline = Date.now() + timeoutMs;
      while (this.active > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      if (this.active > 0) throw new Error("In-flight game operation did not finish; restart aborted");
      if (game.getLifecycleToken() !== identity) throw new Error("Game lifecycle changed while capture waited");
      const snapshot = createGameSnapshot(game, teamCommand);
      await store.save(snapshot);
      if (game.getLifecycleToken() !== identity || this.active > 0) {
        throw new Error("Game lifecycle changed during snapshot persistence; pending snapshot requires inspection");
      }
      // Detect mutations originating outside the tracked admission boundary
      // while fsync/read-back was in progress. The published artifact stays
      // blocked for review; it is never used to authorize a restart.
      const afterWrite = createGameSnapshot(game, teamCommand);
      if (JSON.stringify(afterWrite.game) !== JSON.stringify(snapshot.game) ||
          JSON.stringify(afterWrite.workflows) !== JSON.stringify(snapshot.workflows)) {
        throw new Error("Game data changed during snapshot persistence; pending snapshot requires inspection");
      }
      // Stay frozen until the caller exits. No later game mutation may overtake the saved state.
      return snapshot;
    } catch (error) {
      // If publication may have succeeded (even if verification failed), unfreezing
      // could allow later mutations to make the pending snapshot stale.
      let noPending = false;
      try { noPending = !(await store.existsPending()); }
      catch (checkError) { console.error("[game-recovery] Cannot verify pending file after failure", checkError); }
      if (noPending) {
        this.frozen = false;
        this.claimed = false;
        const deferred = this.deferredOnAbort.splice(0);
        for (const retry of deferred) {
          // Invoke after the capture rejection, with admission reopened.
          queueMicrotask(() => {
            if (!this.isFrozen()) retry();
          });
        }
      } else {
        console.error("[game-recovery] Pending snapshot may exist; game operations remain blocked for operator review");
      }
      throw error;
    }
  }
  /** Test-only reset; never use to bypass a production recovery failure. */
  static resetForTests() {
    this.active = 0;
    this.frozen = false;
    this.claimed = false;
    this.startupReason = null;
    this.deferredOnAbort = [];
  }
}
