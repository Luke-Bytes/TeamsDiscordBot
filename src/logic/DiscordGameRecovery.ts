import { AnniClass, AnniMap, SeasonType } from "@prisma/client";
import { Collection, Guild, Message } from "discord.js";
import { ConfigManager } from "../ConfigManager";
import { PlayerInstance } from "../database/PlayerInstance";
import { prismaClient } from "../database/prismaClient";
import { GameInstance } from "../database/GameInstance";
import { SeasonService } from "../database/SeasonService";
import {
  GameRecoveryCoordinator,
  GameSnapshotStore,
} from "./ActiveGameRecovery";
import { MatchRecoveryGate } from "./MatchRecoveryGate";
import { buildTeamPlanRecord, TeamPlanRecord } from "../util/PlanUtil";

export type RecoveryPhase = "announced" | "teams" | "started";
export type RecoveryOptions = {
  phase: RecoveryPhase;
  announcementLink?: string;
  registeredLink?: string;
  teamsLink?: string;
  startTime?: string;
  map?: string;
  bannedClasses?: string;
  modifiers?: string;
  doubleElo?: "yes" | "no";
  organiser?: string;
  host?: string;
  selectionMethod?: GameInstance["teamsDecidedBy"];
  redCaptain?: string;
  blueCaptain?: string;
};

type TeamKey = "RED" | "BLUE" | "UNDECIDED";
type Names = Record<TeamKey, string[]>;
type Announcement = {
  startTime: Date;
  map: AnniMap | null;
  bans: AnniClass[] | null;
  modifiers: { category: string; name: string }[] | null;
  doubleElo: boolean;
  relaxed: boolean;
  organiser?: string;
  host?: string;
};
export type RecoveryProposal = {
  fingerprint: string;
  sourceSummary: string[];
  warnings: string[];
  startTime: Date;
  organiser: string;
  host: string;
  map: AnniMap;
  bannedClasses: AnniClass[];
  modifiers: { category: string; name: string }[];
  doubleElo: boolean;
  relaxed: boolean;
  phase: RecoveryPhase;
  /** Discord /game end is not a persisted match; keep its post-game state. */
  recoveredEndTime?: Date;
  teamsDecidedBy: GameInstance["teamsDecidedBy"];
  teams: Record<TeamKey, PlayerInstance[]>;
  lateSignups: string[];
  seasonId: string;
  seasonNumber: number;
  redPlan?: TeamPlanRecord;
  bluePlan?: TeamPlanRecord;
  announcementMessage?: Message<true>;
};

const emptyNames = (): Names => ({ RED: [], BLUE: [], UNDECIDED: [] });
const normal = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const ignKey = (name: string) => name.toLowerCase();
const isAnnouncement = (msg: Message) =>
  msg.embeds.some(
    (embed) =>
      /FRIENDLY WAR ANNOUNCEMENT/i.test(embed.title ?? "") &&
      !/PREVIEW/i.test(embed.title ?? "")
  );
const isRegistration = (msg: Message) =>
  msg.embeds.some((embed) =>
    /^Registered Players \(\d+\)/i.test(embed.title ?? "")
  );
const isTeams = (msg: Message) =>
  msg.embeds.some((embed) =>
    /^(Current Teams|Snake Drafting Teams|Drafting Teams)$/i.test(
      embed.title ?? ""
    )
  );

export function parseDiscordMessageLink(
  link: string,
  guildId: string
): { channelId: string; messageId: string } {
  const match =
    /^https:\/\/(?:canary\.|ptb\.)?(?:discord(?:app)?\.com)\/channels\/(\d{15,22})\/(\d{15,22})\/(\d{15,22})\/?$/.exec(
      link.trim()
    );
  if (!match || match[1] !== guildId)
    throw new Error("Message link must be a Discord message in this server.");
  return { channelId: match[2], messageId: match[3] };
}

const extractIgns = (text: string, allowElo = false): string[] => {
  const names: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/\\_/g, "_")
      .replace(/[*\x60]/g, "")
      .trim();
    if (
      !line ||
      /^(?:No players|None|No players have registered yet\.)$/i.test(line)
    )
      continue;
    if (line.includes("...")) throw new Error("Player list appears truncated.");
    // Drafts use ELO emoji prefixes; never accept arbitrary prose as a username.
    const match =
      /^(?:(?::(?:skull_crossbones|black_circle|white_circle|star|gem|radioactive|cold_face|trophy):|[⚫⚪🟡🟢🔴🔵🟣🟠👑])\s*)*([A-Za-z0-9_]{3,16})(?:\s+\[(\d{1,6})\])?$/u.exec(
        line
      );
    if (!match || (match[2] && !allowElo))
      throw new Error(`Malformed player list entry: ${line.slice(0, 40)}`);
    names.push(match[1]);
  }
  return names;
};

export function parseRegistration(message: Pick<Message, "embeds">): {
  names: string[];
  late: string[];
} {
  const embed = message.embeds.find((item) =>
    /^Registered Players \(\d+\)/i.test(item.title ?? "")
  );
  if (!embed) throw new Error("Not a registered-players embed.");
  const names = extractIgns(embed.description ?? "");
  const lateFields = embed.fields.filter((field) =>
    /Late Signups/i.test(field.name)
  );
  if (lateFields.length > 1)
    throw new Error(
      "Multiple Late Signups fields make registration ambiguous."
    );
  const late = lateFields.flatMap((field) => {
    const declared = /^\s*Late Signups\s*\((\d+)\)\s*$/i.exec(field.name);
    if (!declared) throw new Error("Malformed Late Signups count.");
    const parsed = extractIgns(field.value);
    if (parsed.length !== Number(declared[1]) || field.value.includes("..."))
      throw new Error(
        "Late Signups count does not match its names (possibly truncated)."
      );
    return parsed;
  });
  const count = Number(/\((\d+)\)/.exec(embed.title ?? "")?.[1]);
  if (names.length !== count || (embed.description ?? "").includes("..."))
    throw new Error(
      "Registered feed count does not match its names (possibly truncated)."
    );
  const all = [...names, ...late].map(ignKey);
  if (new Set(all).size !== all.length)
    throw new Error("Registered and Late Signups contain duplicate usernames.");
  return { names: [...names, ...late], late };
}

export function parseTeams(message: Pick<Message, "embeds">): {
  names: Names;
  method: GameInstance["teamsDecidedBy"] | null;
  captains: { RED?: string; BLUE?: string };
} {
  const embed = message.embeds.find((item) =>
    /^(Current Teams|Snake Drafting Teams|Drafting Teams)$/i.test(
      item.title ?? ""
    )
  );
  if (!embed) throw new Error("Not a recognised teams embed.");
  const result = emptyNames();
  const fieldsSeen = new Set<TeamKey>();
  for (const field of embed.fields) {
    const team: TeamKey | null = /Red Team/i.test(field.name)
      ? "RED"
      : /Blue Team/i.test(field.name)
        ? "BLUE"
        : /Up for Grabs/i.test(field.name)
          ? "UNDECIDED"
          : null;
    if (!team) continue;
    if (fieldsSeen.has(team))
      throw new Error(`Duplicate ${team} field in teams embed.`);
    fieldsSeen.add(team);
    result[team] = extractIgns(field.value, team === "UNDECIDED");
    const claimed = /\[(\d+)\]/.exec(field.name);
    if (claimed && result[team].length !== Number(claimed[1])) {
      throw new Error(
        `Teams embed ${team} count does not match listed players.`
      );
    }
  }
  const title = embed.title ?? "";
  return {
    names: result,
    method: /Snake Drafting/i.test(title)
      ? "SNAKE_DRAFT"
      : /^Drafting Teams/i.test(title)
        ? "DRAFT"
        : null,
    captains: { RED: result.RED[0], BLUE: result.BLUE[0] },
  };
}

function enumValue<T extends string>(
  value: string,
  choices: readonly T[]
): T | null {
  return choices.find((item) => normal(item) === normal(value)) ?? null;
}
export function parseBans(value: string): AnniClass[] {
  if (/^none$/i.test(value.trim())) return [];
  const items = value
    .split(/[,\n]/)
    .map((item) => item.replace(/\*/g, "").trim())
    .filter(Boolean);
  if (!items.length)
    throw new Error("Banned classes must be 'none' or a comma-separated list.");
  return [
    ...new Set(
      items.map((item) => {
        const result = enumValue(item, Object.values(AnniClass));
        if (!result) throw new Error(`Unknown banned class: ${item}`);
        return result;
      })
    ),
  ];
}
export function parseModifiers(
  value: string
): { category: string; name: string }[] {
  if (/^none$/i.test(value.replace(/\*/g, "").trim())) return [];
  const parts = value
    .replace(/\*/g, "")
    .split(/[\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!parts.length)
    throw new Error("Modifiers must be 'none' or Category: Value entries.");
  return parts.map((part) => {
    const colon = part.indexOf(":");
    if (colon <= 0 || colon === part.length - 1)
      throw new Error(`Invalid modifier: ${part}`);
    return {
      category: part.slice(0, colon).trim(),
      name: part.slice(colon + 1).trim(),
    };
  });
}
export function parseAnnouncement(
  message: Pick<Message, "embeds">
): Announcement {
  const embed = message.embeds.find(
    (item) =>
      /FRIENDLY WAR ANNOUNCEMENT/i.test(item.title ?? "") &&
      !/PREVIEW/i.test(item.title ?? "")
  );
  if (!embed) throw new Error("Not a confirmed game announcement.");
  const field = (name: string) =>
    embed.fields.find((item) => item.name.toUpperCase().includes(name))?.value;
  const unix = /<t:(\d{9,12})(?::[A-Za-z])?>/.exec(field("TIME") ?? "");
  if (!unix)
    throw new Error("Announcement does not contain a Discord timestamp.");
  const startTime = new Date(Number(unix[1]) * 1000);
  if (Number.isNaN(startTime.getTime()))
    throw new Error("Invalid announcement timestamp.");
  const mapRaw = field("MAP")?.replace(/\*/g, "").trim() ?? "";
  const map = enumValue(mapRaw, Object.values(AnniMap));
  const bansRaw = field("BANNED CLASSES");
  const modifierRaw = field("MODIFIERS");
  const footer = embed.footer?.text ?? "";
  const nameMatch = /^Organised by (.*?)(?: - Hosted by (.*))?$/.exec(footer);
  const hostMatch = /^Hosted by (.*)$/.exec(footer);
  return {
    startTime,
    map,
    bans: bansRaw ? parseBans(bansRaw) : null,
    modifiers: modifierRaw ? parseModifiers(modifierRaw) : null,
    doubleElo: /DOUBLE ELO/i.test(embed.description ?? ""),
    relaxed: /Relaxed season/i.test(embed.description ?? ""),
    organiser: nameMatch?.[1],
    host: nameMatch?.[2] ?? hostMatch?.[1],
  };
}

function manualTime(value: string): Date {
  // Require an explicit offset to avoid accidental server-local timezone interpretation.
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(
      value
    )
  ) {
    throw new Error(
      "start_time must be ISO 8601 with timezone, e.g. 2026-11-20T22:00:00Z."
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid start_time.");
  return date;
}

async function fetchLinked(
  guild: Guild,
  link: string,
  expected: (msg: Message) => boolean,
  label: string,
  allowedChannels: string[]
): Promise<Message<true>> {
  const { channelId, messageId } = parseDiscordMessageLink(link, guild.id);
  if (!allowedChannels.includes(channelId))
    throw new Error(`${label} link is not in an allowed channel.`);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !("messages" in channel))
    throw new Error(`${label} message channel cannot be read.`);
  const message = await channel.messages.fetch(messageId);
  if (
    !message.inGuild() ||
    message.guildId !== guild.id ||
    message.channelId !== channelId ||
    message.author.id !== guild.client.user?.id ||
    !expected(message)
  ) {
    throw new Error(
      `${label} link must point to a matching message sent by this bot in this server.`
    );
  }
  return message as Message<true>;
}

async function channelHistory(
  guild: Guild,
  channelId: string,
  after: number
): Promise<Message<true>[]> {
  if (!channelId) throw new Error("Channel is not configured.");
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !("messages" in channel))
    throw new Error("Channel cannot be read.");
  const messages: Message<true>[] = [];
  let before: string | undefined;
  for (let page = 0; page < 4; page++) {
    const fetched: Collection<
      string,
      Message<true>
    > = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });
    if (!fetched.size) break;
    messages.push(...fetched.values());
    const sorted = [...fetched.values()].sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp
    );
    before = sorted[0].id;
    if (sorted[0].createdTimestamp < after) break;
    if (page === 3 && fetched.size === 100)
      throw new Error(
        "Discord history pagination limit reached before the game window was fully scanned."
      );
  }
  return messages.filter((msg) => msg.createdTimestamp >= after);
}

async function requiredHistory(
  guild: Guild,
  channelId: string,
  after: number,
  label: string
): Promise<Message<true>[]> {
  try {
    return await channelHistory(guild, channelId, after);
  } catch (error) {
    throw new Error(
      `Cannot verify ${label} channel history: ${error instanceof Error ? error.message : "Discord error"}`
    );
  }
}

async function optionalHistory(
  guild: Guild,
  channelId: string,
  after: number,
  warnings: string[]
): Promise<Message<true>[]> {
  try {
    return await channelHistory(guild, channelId, after);
  } catch (error) {
    if (error instanceof Error && /pagination limit/i.test(error.message))
      throw new Error(
        `Cannot complete Discord history pagination for channel ${channelId}.`
      );
    warnings.push(
      `Could not read channel ${channelId}: ${error instanceof Error ? error.message : "Discord error"}`
    );
    return [];
  }
}
function latest(
  messages: Message<true>[],
  predicate: (msg: Message) => boolean
): Message<true> | undefined {
  return messages
    .filter((msg) => predicate(msg) && msg.author.id === msg.client.user?.id)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
}
function draftFinalisationSignal(
  draft: Message<true>,
  picking: Message<true>[]
): Message<true> | undefined {
  return picking
    .filter(
      (m) =>
        m.author.id === draft.client.user?.id &&
        m.createdTimestamp >= draft.createdTimestamp &&
        m.createdTimestamp <= draft.createdTimestamp + 60 * 60_000 &&
        /^(?:Teams have been finalised!|Teams have been locked!)$/i.test(
          m.content.trim()
        )
    )
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)[0];
}

function isDraftConfirmed(
  draft: Message<true>,
  picking: Message<true>[]
): boolean {
  const embed = draft.embeds.find((e) =>
    /^(Snake Drafting Teams|Drafting Teams)$/i.test(e.title ?? "")
  );
  if (!embed) return false;
  if (/Select an action below/i.test(embed.footer?.text ?? "")) return false;
  if (
    embed.fields.some(
      (field) =>
        /Late Signups/i.test(field.name) && extractIgns(field.value).length > 0
    )
  )
    return false;
  if (parseTeams(draft).names.UNDECIDED.length > 0) return false;
  if (/Teams have been finalised|Teams have been locked/i.test(draft.content))
    return true;
  return !!draftFinalisationSignal(draft, picking);
}

function postGameSignals(messages: Message<true>[]): Message<true>[] {
  // /game end opens MVP voting but does not persist anything. /game shutdown
  // performs the save; only the database check can establish that it committed.
  // Trust bot-authored evidence only, scoped to this announcement.
  return messages
    .filter(
      (msg) =>
        msg.author.id === msg.client.user?.id &&
        (/(?:the game has now ended|the game is over|voting for the team MVP is now open|beginning post game clean up)/i.test(
          msg.content
        ) ||
          msg.embeds.some((embed) =>
            /game over|match result/i.test(embed.title ?? "")
          ))
    )
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

/** An unannounced but partially prepared or crashed game is still an active claim. */
function hasUnresolvedGameState(game: GameInstance): boolean {
  return !!(
    game.announced ||
    game.gameId ||
    game.getGameStartStatus() !== "idle" ||
    game.isRestarting ||
    game.isFinished ||
    game.startTime ||
    game.endTime ||
    game.getPlayers().length ||
    game.lateSignups.size ||
    game.captainNominations.size ||
    game.recoveryDraftProgress ||
    game.recoveryPausedWorkflows.length ||
    game.organiser ||
    game.host ||
    game.teamsDecidedBy ||
    game.settings.map ||
    game.settings.organiserBannedClasses.length ||
    game.settings.modifiers.length ||
    game.redTeamPlan ||
    game.blueTeamPlan ||
    game.announcementMessage
  );
}

export async function ensureRecoveryAllowed(
  startTime?: Date,
  underExclusiveLock = false
): Promise<void> {
  const game = GameInstance.getInstance();
  if (hasUnresolvedGameState(game)) {
    throw new Error(
      "There is already a current game or unresolved game state. Recovery cannot overwrite it."
    );
  }
  if (MatchRecoveryGate.getBlockReason())
    throw new Error(
      `Database cleanup is unresolved: ${MatchRecoveryGate.getBlockReason()}`
    );
  const coordinatorBlock = GameRecoveryCoordinator.getBlockReason();
  if (
    coordinatorBlock &&
    !(
      underExclusiveLock &&
      GameRecoveryCoordinator.isDiscordRecoveryClaimed() &&
      !GameRecoveryCoordinator.isSnapshotBlocked()
    )
  )
    throw new Error(`Game recovery is unresolved: ${coordinatorBlock}`);
  const store = new GameSnapshotStore();
  if (
    (await store.existsPending()) ||
    (await store.hasIncompletePublication())
  ) {
    throw new Error(
      "A restart snapshot is pending/incomplete. Resolve snapshot recovery before attempting message-based recovery."
    );
  }
  if (startTime) {
    // The original in-memory UUID cannot be recovered from an ordinary feed embed.
    // Fail closed for any persisted match at approximately the same scheduled time.
    const existing = await prismaClient.game.findFirst({
      where: {
        startTime: {
          gte: new Date(startTime.getTime() - 90 * 60_000),
          lte: new Date(startTime.getTime() + 90 * 60_000),
        },
      },
      select: { id: true },
    });
    if (existing)
      throw new Error(
        "A match with this scheduled time is already stored in the database. Recovery refused."
      );
  }
}

function uniqueNames(names: Names): void {
  const all = Object.values(names).flat().map(ignKey);
  if (new Set(all).size !== all.length)
    throw new Error(
      "The recovered roster contains duplicate usernames across teams."
    );
}

export async function buildDiscordRecovery(
  guild: Guild,
  options: RecoveryOptions,
  underExclusiveLock = false
): Promise<RecoveryProposal> {
  await ensureRecoveryAllowed(undefined, underExclusiveLock);
  const config = ConfigManager.getConfig();
  const warnings: string[] = [];
  const fromInput = options.startTime
    ? manualTime(options.startTime)
    : undefined;
  const cutoff = (fromInput?.getTime() ?? Date.now()) - 48 * 60 * 60_000;
  const announceHistory = await requiredHistory(
    guild,
    config.channels.announcements,
    cutoff,
    "announcement"
  );
  const adminHistory = await requiredHistory(
    guild,
    config.channels.botCommands,
    cutoff,
    "bot commands"
  );
  const announcements = [...announceHistory, ...adminHistory].filter(
    (m) => isAnnouncement(m) && m.author.id === guild.client.user?.id
  );
  if (
    !options.announcementLink &&
    new Set(announcements.map((m) => m.id)).size > 1
  )
    throw new Error(
      "Multiple game announcements are in range; supply announcement_link to select the correct game."
    );
  const announcementMessage = options.announcementLink
    ? await fetchLinked(
        guild,
        options.announcementLink,
        isAnnouncement,
        "Announcement",
        [config.channels.announcements, config.channels.botCommands]
      )
    : latest(announcements, isAnnouncement);
  const announcement = announcementMessage
    ? parseAnnouncement(announcementMessage)
    : undefined;
  const startTime = fromInput ?? announcement?.startTime;
  if (!startTime)
    throw new Error(
      "Announcement not found. Supply announcement_link or start_time (ISO date with timezone), plus the missing game settings."
    );
  if (
    announcement &&
    fromInput &&
    Math.abs(fromInput.getTime() - announcement.startTime.getTime()) > 60_000
  ) {
    throw new Error(
      "The manual start_time disagrees with the announcement timestamp."
    );
  }
  if (
    startTime.getTime() > Date.now() + 30 * 24 * 60 * 60_000 ||
    startTime.getTime() < Date.now() - 14 * 24 * 60 * 60_000
  ) {
    throw new Error(
      "Only games scheduled within the last 14 days or next 30 days can be recovered."
    );
  }
  await ensureRecoveryAllowed(startTime, underExclusiveLock);
  const map = options.map
    ? enumValue(options.map, Object.values(AnniMap))
    : announcement?.map;
  if (!map)
    throw new Error("The map is unknown. Supply map (an exact game map name).");
  const bans =
    options.bannedClasses !== undefined
      ? parseBans(options.bannedClasses)
      : announcement?.bans;
  if (!bans)
    throw new Error(
      "Banned classes are unknown. Supply banned_classes (or 'none')."
    );
  const modifiers =
    options.modifiers !== undefined
      ? parseModifiers(options.modifiers)
      : announcement?.modifiers;
  if (!modifiers)
    throw new Error("Modifiers are unknown. Supply modifiers (or 'none').");
  if (!announcement && !options.doubleElo)
    throw new Error("Double ELO is unknown. Supply double_elo yes/no.");
  const doubleElo = options.doubleElo
    ? options.doubleElo === "yes"
    : (announcement?.doubleElo ?? false);
  const season = await SeasonService.requireActiveSeason();
  if (!season.isActive)
    throw new Error("Active season became inactive during recovery.");
  const relaxed = season.type === SeasonType.RELAXED;
  if (announcement && announcement.relaxed !== relaxed) {
    warnings.push(
      "Season type differs from the announcement; active season settings will apply."
    );
  }
  const after = startTime.getTime() - 24 * 60 * 60_000;
  const [
    feedHistory,
    pickingHistory,
    redHistory,
    blueHistory,
    registrationHistory,
  ] = await Promise.all([
    requiredHistory(guild, config.channels.gameFeed, after, "game feed"),
    requiredHistory(
      guild,
      config.channels.teamPickingChat,
      after,
      "team picking"
    ),
    optionalHistory(guild, config.channels.redTeamChat, after, warnings),
    optionalHistory(guild, config.channels.blueTeamChat, after, warnings),
    optionalHistory(guild, config.channels.registration, after, warnings),
  ]);
  const until = startTime.getTime() + 24 * 60 * 60_000;
  const inPeriod = (messages: Message<true>[]) =>
    messages.filter(
      (msg) =>
        msg.createdTimestamp <= until &&
        (!announcementMessage ||
          msg.createdTimestamp >= announcementMessage.createdTimestamp - 60_000)
    );
  const feeds = inPeriod(feedHistory);
  const picking = inPeriod(pickingHistory);
  const registration = inPeriod(registrationHistory);
  // End-of-game evidence can arrive days after the scheduled start, even
  // though registration/team selection is scoped to the original game day.
  // Do not attribute messages from a later announcement to this game.
  const nextAnnouncementTime = [...announceHistory, ...adminHistory]
    .filter(
      (msg) =>
        msg.author.id === guild.client.user?.id &&
        isAnnouncement(msg) &&
        msg.createdTimestamp >
          (announcementMessage?.createdTimestamp ?? startTime.getTime())
    )
    .sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp
    )[0]?.createdTimestamp;
  const laterGameHistory = (messages: Message<true>[]) =>
    messages.filter(
      (msg) =>
        msg.createdTimestamp >=
          Math.max(
            after,
            (announcementMessage?.createdTimestamp ?? after) - 60_000
          ) &&
        msg.createdTimestamp <= Date.now() &&
        (nextAnnouncementTime === undefined ||
          msg.createdTimestamp < nextAnnouncementTime)
    );
  const endSignals = postGameSignals([
    ...laterGameHistory(feedHistory),
    ...laterGameHistory(pickingHistory),
    ...laterGameHistory(adminHistory),
    ...laterGameHistory(redHistory),
    ...laterGameHistory(blueHistory),
  ]);
  if (endSignals.length && options.phase !== "started") {
    throw new Error(
      "Discord shows this game reached /game end. Choose phase 'started' to recover the ended but unsaved game."
    );
  }
  const recoveredEndTime = endSignals.length
    ? new Date(Math.max(startTime.getTime(), endSignals[0].createdTimestamp))
    : undefined;
  if (recoveredEndTime) {
    warnings.push(
      "Discord shows /game end or post-game activity, but no saved match was found. The game will be restored as ended with an approximate end time; prior MVP votes cannot be reconstructed and must be recast before shutdown."
    );
  }

  if (
    announcementMessage &&
    !options.registeredLink &&
    [...feedHistory, ...registrationHistory].some(
      (m) =>
        isRegistration(m) &&
        m.author.id === guild.client.user?.id &&
        m.createdTimestamp >= after &&
        m.createdTimestamp < announcementMessage.createdTimestamp - 60_000
    ) &&
    !latest([...feeds, ...registration], isRegistration)
  ) {
    throw new Error(
      "Only a registration feed predating the announcement was found; supply a correct registered_link or verify the game history."
    );
  }
  const registeredMessage = options.registeredLink
    ? await fetchLinked(
        guild,
        options.registeredLink,
        isRegistration,
        "Registration",
        [config.channels.registration, config.channels.gameFeed]
      )
    : latest([...feeds, ...registration], isRegistration);
  const teamsMessage = options.teamsLink
    ? await fetchLinked(guild, options.teamsLink, isTeams, "Teams", [
        config.channels.gameFeed,
        config.channels.teamPickingChat,
      ])
    : latest(
        [...feeds, ...picking],
        (msg) =>
          isTeams(msg) &&
          (/^Current Teams$/i.test(msg.embeds[0]?.title ?? "") ||
            /Teams have been locked|Teams have been finalised/i.test(
              msg.content
            ) ||
            msg.createdTimestamp >= startTime.getTime() - 60 * 60_000)
      );
  if (!registeredMessage && !teamsMessage) {
    throw new Error(
      "No usable registration or teams embed found. Supply registered_link or teams_link from the bot."
    );
  }
  if (
    registeredMessage &&
    (registeredMessage.createdTimestamp < after ||
      registeredMessage.createdTimestamp > until)
  ) {
    throw new Error("Registration message is from another game period.");
  }
  if (
    teamsMessage &&
    (teamsMessage.createdTimestamp < after ||
      teamsMessage.createdTimestamp > until)
  ) {
    throw new Error("Teams message is from another game period.");
  }
  if (
    announcementMessage &&
    [registeredMessage, teamsMessage].some(
      (m) =>
        m && m.createdTimestamp < announcementMessage.createdTimestamp - 60_000
    )
  )
    throw new Error("Roster or teams message predates this game announcement.");
  const registrations = registeredMessage
    ? parseRegistration(registeredMessage)
    : { names: [], late: [] };
  const parsedTeams = teamsMessage ? parseTeams(teamsMessage) : null;
  if (
    options.phase !== "announced" &&
    (!parsedTeams ||
      !parsedTeams.names.RED.length ||
      !parsedTeams.names.BLUE.length)
  ) {
    throw new Error(
      "Team assignments are required for this phase. Supply teams_link to the final draft/current-teams message."
    );
  }
  if (
    options.phase === "announced" &&
    parsedTeams &&
    (parsedTeams.names.RED.length || parsedTeams.names.BLUE.length)
  ) {
    throw new Error(
      "Teams exist in the recovered history. Choose phase 'teams' or 'started' rather than 'announced'."
    );
  }
  if (options.phase === "started" && !parsedTeams)
    throw new Error("Cannot recover a started game without final teams.");
  if (options.phase !== "announced" && parsedTeams?.names.UNDECIDED.length)
    throw new Error("Draft is not final: players are still Up for Grabs.");
  if (
    options.phase !== "announced" &&
    parsedTeams?.method &&
    teamsMessage &&
    !isDraftConfirmed(teamsMessage, picking)
  ) {
    throw new Error(
      "Draft is not confirmed as final; use an accepted final draft or final Current Teams feed."
    );
  }
  const names = parsedTeams?.names ?? emptyNames();
  if (registeredMessage && parsedTeams) {
    const registered = new Set(registrations.names.map(ignKey));
    if (
      [...names.RED, ...names.BLUE].some(
        (name) => !registered.has(ignKey(name))
      )
    )
      throw new Error(
        "Teams contain usernames absent from the current registration feed; game evidence is inconsistent."
      );
  }
  const seen = new Set(Object.values(names).flat().map(ignKey));
  for (const name of registrations.names) {
    if (!seen.has(ignKey(name))) {
      names.UNDECIDED.push(name);
      seen.add(ignKey(name));
    }
  }
  uniqueNames(names);
  if (names.RED.length + names.BLUE.length + names.UNDECIDED.length === 0)
    throw new Error("Recovered roster is empty.");
  // A current-teams feed does not record the selection method. Recover it
  // only when the same finalized roster appears in the original draft embed.
  const finalDraft = latest(picking, (msg) =>
    /^(Snake Drafting Teams|Drafting Teams)$/i.test(msg.embeds[0]?.title ?? "")
  );
  let draftMethod: GameInstance["teamsDecidedBy"] | null = null;
  if (finalDraft && parsedTeams && !parsedTeams.method) {
    const drafted = parseTeams(finalDraft);
    const same = (team: "RED" | "BLUE") =>
      drafted.names[team].length === names[team].length &&
      drafted.names[team].every((name) =>
        names[team].some((n) => ignKey(n) === ignKey(name))
      );
    if (same("RED") && same("BLUE") && isDraftConfirmed(finalDraft, picking))
      draftMethod = drafted.method;
  }
  const method =
    options.selectionMethod ?? parsedTeams?.method ?? draftMethod ?? null;
  if (options.phase !== "announced" && !method) {
    throw new Error(
      "Selection method is not recoverable from the current-teams feed. Supply selection_method."
    );
  }

  // The current username is more authoritative than a historical alias:
  // Minecraft usernames can change owners. Only use history when no profile's
  // latestIGN matches, and fail closed on genuine current-name ambiguity.
  // The stored primary UUID is a second identity safeguard when available.
  const allPlayers = await prismaClient.player.findMany();
  const resolved: Record<TeamKey, PlayerInstance[]> = {
    RED: [],
    BLUE: [],
    UNDECIDED: [],
  };
  for (const team of ["RED", "BLUE", "UNDECIDED"] as const) {
    for (const name of names[team]) {
      const currentMatches = allPlayers.filter(
        (player) => player.latestIGN?.toLowerCase() === ignKey(name)
      );
      const matching = currentMatches.length
        ? currentMatches
        : allPlayers.filter((player) =>
            player.minecraftAccounts.some(
              (ign) => ign.toLowerCase() === ignKey(name)
            )
          );
      if (matching.length !== 1)
        throw new Error(
          `Cannot uniquely match IGN ${name} to a stored Discord player (${matching.length} ${currentMatches.length ? "current IGN" : "historical"} matches). Correct the database/roster before recovering.`
        );
      const player = matching[0];
      if (
        player.primaryMinecraftAccount &&
        allPlayers.some(
          (other) =>
            other.id !== player.id &&
            other.primaryMinecraftAccount?.toLowerCase() ===
              player.primaryMinecraftAccount?.toLowerCase()
        )
      ) {
        throw new Error(
          `Minecraft UUID for IGN ${name} is claimed by multiple Discord players. Resolve the conflicting accounts before recovery.`
        );
      }
      if (!currentMatches.length) {
        warnings.push(
          `IGN ${name} was matched only through a historical username for a single stored player. Confirm the current Minecraft account/UUID before proceeding.`
        );
      }
      const stats = await prismaClient.playerStats.findUnique({
        where: {
          playerId_seasonId: { playerId: player.id, seasonId: season.id },
        },
      });
      if (!stats)
        throw new Error(
          `No season stats for ${name}. Recovery does not create database records.`
        );
      const instance = new PlayerInstance(player, stats);
      instance.ignUsed = name;
      resolved[team].push(instance);
    }
  }
  const ids = Object.values(resolved)
    .flat()
    .map((player) => player.discordSnowflake);
  const lateSignups = registrations.late.map((name) => {
    const player = Object.values(resolved)
      .flat()
      .find((p) => ignKey(p.ignUsed ?? "") === ignKey(name));
    if (!player) throw new Error(`Late Signup ${name} could not be resolved.`);
    return player.discordSnowflake;
  });
  if (new Set(ids).size !== ids.length)
    throw new Error(
      "Multiple recovered usernames point to the same Discord member."
    );
  for (const team of ["RED", "BLUE"] as const) {
    const captain =
      team === "RED"
        ? (options.redCaptain ?? parsedTeams?.captains.RED)
        : (options.blueCaptain ?? parsedTeams?.captains.BLUE);
    if (options.phase !== "announced" && !captain)
      throw new Error(
        `Cannot determine ${team} captain; supply ${team.toLowerCase()}_captain.`
      );
    const member = resolved[team].find(
      (p) => ignKey(p.ignUsed ?? "") === ignKey(captain ?? "")
    );
    if (options.phase !== "announced" && !member)
      throw new Error(`${team} captain is not a member of that team.`);
    if (member) member.captain = true;
  }
  if (
    options.phase !== "announced" &&
    (!options.redCaptain || !options.blueCaptain)
  ) {
    warnings.push(
      "Captains inferred from the first entry of each team. Verify them before confirming."
    );
  }
  if (!registeredMessage)
    warnings.push(
      "Registration feed missing; only players from the team embed were recovered."
    );
  if (!announcementMessage)
    warnings.push(
      "Announcement missing; organiser-supplied settings are used."
    );
  if (
    !(options.organiser ?? announcement?.organiser) ||
    !(options.host ?? announcement?.host)
  ) {
    warnings.push(
      "Organiser and/or host is unknown; set organiser_name and host_name to avoid saving Unknown later."
    );
  }
  if (options.phase === "started")
    warnings.push(
      "Marked as started; /game start will not re-run roles, moves or messages."
    );
  warnings.push(
    "Original game UUID, draft slots, captain class-ban history, MVP votes and automatic timers cannot be reconstructed."
  );
  warnings.push(
    "Discord roles/voice channels and feed messages are NOT modified by recovery."
  );
  const plans = (
    history: Message<true>[]
  ): {
    plan?: TeamPlanRecord;
    evidence?: {
      id: string;
      url: string;
      channelId: string;
      authorId: string;
      createdTimestamp: number;
      editedTimestamp?: number | null;
      content: string;
    };
  } => {
    const msg = inPeriod(history)
      .filter(
        (m) =>
          m.author.id !== guild.client.user?.id &&
          /Mid Blocks Plan/i.test(m.content) &&
          /Game Plan/i.test(m.content)
      )
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (!msg) return {};
    const plan = buildTeamPlanRecord(msg.content, "CHANNEL") ?? undefined;
    if (plan) plan.capturedAt = new Date(msg.createdTimestamp);
    return {
      plan,
      evidence: {
        id: msg.id,
        url: msg.url,
        channelId: msg.channelId,
        authorId: msg.author.id,
        createdTimestamp: msg.createdTimestamp,
        editedTimestamp: msg.editedTimestamp,
        content: msg.content,
      },
    };
  };
  const { plan: redPlan, evidence: redPlanEvidence } = plans(redHistory);
  const { plan: bluePlan, evidence: bluePlanEvidence } = plans(blueHistory);
  const draftUsed = parsedTeams?.method ? teamsMessage : finalDraft;
  const approvalEvidence = draftUsed
    ? draftFinalisationSignal(draftUsed, picking)
    : undefined;
  const sourceSummary = [
    `Announcement: ${announcementMessage?.url ?? "manual settings"}`,
    `Registration: ${registeredMessage?.url ?? "team roster only"}`,
    `Teams: ${teamsMessage?.url ?? "not yet picked"}`,
    `Draft approval: ${approvalEvidence?.url ?? (draftUsed && /Teams have been finalised|Teams have been locked/i.test(draftUsed.content) ? draftUsed.url : "not independently verified")}`,
    `Game end: ${endSignals[0]?.url ?? "not found"}`,
    `Red plan: ${redPlanEvidence?.url ?? "none"}${redPlanEvidence ? ` (author ${redPlanEvidence.authorId})` : ""}`,
    `Blue plan: ${bluePlanEvidence?.url ?? "none"}${bluePlanEvidence ? ` (author ${bluePlanEvidence.authorId})` : ""}`,
  ];
  const fingerprint = JSON.stringify({
    season: {
      id: season.id,
      number: season.number,
      type: season.type,
      isActive: season.isActive,
      gameLimit: season.gameLimit,
      monthLimit: season.monthLimit,
      rankedGameLimit: season.rankedGameLimit,
      rankedMonthLimit: season.rankedMonthLimit,
    },
    start: startTime.toISOString(),
    organiser: options.organiser ?? announcement?.organiser ?? "Unknown",
    host: options.host ?? announcement?.host ?? "Unknown",
    map,
    bans,
    modifiers,
    doubleElo,
    relaxed,
    phase: options.phase,
    recoveredEndTime: recoveredEndTime?.toISOString(),
    endSignals: endSignals.map((msg) => ({
      channelId: msg.channelId,
      id: msg.id,
      createdTimestamp: msg.createdTimestamp,
      editedTimestamp: msg.editedTimestamp,
      content: msg.content,
      embeds: msg.embeds.map((embed) =>
        embed.toJSON ? embed.toJSON() : embed
      ),
    })),
    method,
    ids: Object.fromEntries(
      Object.entries(resolved).map(([team, roster]) => [
        team,
        roster.map((p) => ({
          playerId: p.playerId,
          discordSnowflake: p.discordSnowflake,
          ignUsed: p.ignUsed,
          captain: p.captain,
          elo: p.elo,
          wins: p.wins,
          losses: p.losses,
          winStreak: p.winStreak,
          loseStreak: p.loseStreak,
          biggestWinStreak: p.biggestWinStreak,
          biggestLosingStreak: p.biggestLosingStreak,
          minecraftAccounts: p.minecraftAccounts,
          latestIGN: p.latestIGN,
          primaryMinecraftAccount: p.primaryMinecraftAccount,
        })),
      ])
    ),
    lateSignups,
    redPlan,
    bluePlan,
    redPlanEvidence,
    bluePlanEvidence,
    sources: [
      announcementMessage,
      registeredMessage,
      teamsMessage,
      finalDraft,
      approvalEvidence,
    ].map((m) =>
      m
        ? {
            channelId: m.channelId,
            id: m.id,
            createdTimestamp: m.createdTimestamp,
            editedTimestamp: m.editedTimestamp,
            content: m.content,
            embeds: m.embeds.map((embed) =>
              embed.toJSON ? embed.toJSON() : embed
            ),
          }
        : null
    ),
    sourceSummary,
    warnings,
  });
  return {
    fingerprint,
    sourceSummary,
    warnings,
    startTime,
    map,
    bannedClasses: bans,
    modifiers,
    doubleElo,
    relaxed,
    phase: options.phase,
    recoveredEndTime,
    teamsDecidedBy: method,
    teams: resolved,
    lateSignups,
    seasonId: season.id,
    seasonNumber: season.number,
    organiser: options.organiser ?? announcement?.organiser ?? "Unknown",
    host: options.host ?? announcement?.host ?? "Unknown",
    redPlan,
    bluePlan,
    announcementMessage,
  };
}

export function installDiscordRecovery(proposal: RecoveryProposal): void {
  const game = GameInstance.getInstance();
  if (hasUnresolvedGameState(game))
    throw new Error("Current game changed before recovery.");
  GameRecoveryCoordinator.withDiscordInstallation(() =>
    game.beginConfirmedAnnouncement()
  );
  game.startTime = new Date(proposal.startTime);
  game.organiser = proposal.organiser;
  game.host = proposal.host;
  game.settings.map = proposal.map;
  game.settings.organiserBannedClasses = [...proposal.bannedClasses];
  game.settings.modifiers = proposal.modifiers.map((m) => ({ ...m }));
  game.teams = proposal.teams;
  game.lateSignups = new Set(proposal.lateSignups);
  game.teamsDecidedBy = proposal.teamsDecidedBy;
  game.isDoubleElo = proposal.doubleElo && !proposal.relaxed;
  game.isRelaxedSeason = proposal.relaxed;
  game.noElo =
    proposal.phase === "started" && game.shouldBeNoEloForPlayerCount();
  game.modifierMode = "custom";
  game.redTeamPlan = proposal.redPlan;
  game.blueTeamPlan = proposal.bluePlan;
  game.announcementMessage = proposal.announcementMessage;
  game.recoveryPausedWorkflows = [
    "Original timers, polls, feed updates, draft session and MVP vote collectors were not resumed",
    "Verify captains, banned classes, plans, no-ELO status and Discord roles manually",
  ];
  if (proposal.phase === "started") {
    game.tryBeginGameStart();
    game.completeGameStart();
    if (proposal.recoveredEndTime) {
      game.isFinished = true;
      game.endTime = new Date(proposal.recoveredEndTime);
      game.calculateMeanEloAndExpectedScore();
    }
  }
}
