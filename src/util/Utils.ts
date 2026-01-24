import {
  ChannelType,
  Guild,
  GuildMember,
  PermissionResolvable,
  VoiceChannel,
} from "discord.js";
import { AnniClass, Team } from "@prisma/client";
import { GameInstance } from "../database/GameInstance";
import { ConfigManager } from "../ConfigManager";

export function prettifyName(name: string) {
  return name
    .toLowerCase()
    .split(" ")
    .map((s) => s.charAt(0).toUpperCase() + s.substring(1))
    .join(" ")
    .split("_")
    .join(" ");
}

export function formatDate(date: Date = new Date()): string {
  return date.toISOString().replace("T", " ").split(".")[0];
}

export function getRandomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  const result = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    result.push(arr.slice(i, i + chunkSize));
  }
  return result;
}

export function hasPermissions(
  member: GuildMember,
  requiredPermissions: PermissionResolvable[]
): boolean {
  return requiredPermissions.every((permission) =>
    member.permissions.has(permission)
  );
}

export function parseArgs(input: string): string[] {
  return (
    input.match(/"[^"]+"|\S+/g)?.map((arg) => arg.replace(/(^"|"$)/g, "")) || []
  );
}

export function sanitizeInput(input: string): string {
  return input.replace(/[^a-zA-Z0-9 ]/g, "");
}

export function getEnvVariable(key: string, fallback: string = ""): string {
  return process.env[key] || fallback;
}

export function getUserIdFromMention(mention: string): string | null {
  const matches = mention.match(/^<@!?(\d+)>$/);
  return matches ? matches[1] : null;
}

export function truncateString(str: string, maxLength: number): string {
  return str.length > maxLength ? str.substring(0, maxLength - 3) + "..." : str;
}

//export async function updateRoles(
//  member,
//  addRoles: string[],
//  removeRoles: string[]
//) {
//  for (const role of removeRoles) {
//    if (member.roles.cache.has(role)) {
//      await member.roles
//        .remove(role)
//        .catch((error) =>
//          console.error(
//            `Failed to remove role ${role} from ${member.user.username}: ${error}`
//          )
//        );
//    }
//  }
//  for (const role of addRoles) {
//    if (!member.roles.cache.has(role)) {
//      await member.roles
//        .add(role)
//        .catch((error) =>
//          console.error(
//            `Failed to add role ${role} to ${member.user.username}: ${error}`
//          )
//        );
//    }
//  }
//}

// https://stackoverflow.com/questions/44230998/how-to-get-a-random-enum-in-typescript
export function randomEnum<T extends object>(anEnum: T): T[keyof T] {
  const enumValues = Object.values(anEnum) as unknown as T[keyof T][];
  const randomIndex = Math.floor(Math.random() * enumValues.length);
  return enumValues[randomIndex];
}

export function formatTimestamp(date: Date): string {
  return `<t:${Math.round(date.getTime() / 1000)}:f>`;
}

export const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Operation timed out")), timeoutMs)
    ),
  ]);

export async function formatTeamIGNs(
  game: GameInstance,
  team: Team
): Promise<string> {
  return game
    .getPlayersOfTeam(team)
    .map((p) => `${escapeText(String(p.latestIGN ?? p.ignUsed))} = `)
    .join("\n");
}

export async function checkMissingPlayersInVC(
  guild: Guild,
  team: "RED" | "BLUE",
  reply: (message: string) => Promise<void>
) {
  const config = ConfigManager.getConfig();
  const vcId =
    team === "RED" ? config.channels.redTeamVC : config.channels.blueTeamVC;

  const vc = guild.channels.cache.get(vcId) as VoiceChannel;

  if (!vc || vc.type !== ChannelType.GuildVoice) {
    await reply(`No valid VC found for ${team} team.`);
    return;
  }

  const membersInVC = Array.from(vc.members.values()).map((m) => m.id);

  const gameInstance = GameInstance.getInstance();
  const teamPlayers = gameInstance.getPlayersOfTeam(team);

  const missingPlayers = teamPlayers.filter(
    (player) => !membersInVC.includes(player.discordSnowflake)
  );

  if (missingPlayers.length === 0) {
    await reply(`No expected players missing from ${team} team's VC.`);
  } else {
    const missingNames = missingPlayers
      .map((player) => `<@${player.discordSnowflake}>`)
      .join(", ");
    await reply(
      `The following ${team} players are missing from VC: \n${missingNames}`
    );
  }
}

export function escapeText(text: string): string {
  let escaped = text;
  const doubleDelimiters = ["**", "__", "~~"];
  const singleDelimiters = ["*", "_", "`", "|"];

  for (const delimiter of doubleDelimiters) {
    escaped = escapeDelimitedSections(escaped, delimiter);
  }
  for (const delimiter of singleDelimiters) {
    escaped = escapeDelimitedSections(escaped, delimiter);
    escaped = escapeUnpairedDelimiter(escaped, delimiter);
  }

  return escaped.replace(/(^|\n)>/g, "$1\\>");
}

export function stripVariationSelector(emoji: string): string {
  return emoji.replace(/\uFE0F/g, "");
}

const allAnniClasses = Object.values(AnniClass) as AnniClass[];

export function getRandomAnniClass(): AnniClass {
  const idx = Math.floor(Math.random() * allAnniClasses.length);
  return allAnniClasses[idx];
}

function escapeDelimitedSections(text: string, delimiter: string) {
  const escapedDelimiter = escapeForRegex(delimiter);
  const pairPattern = new RegExp(
    `(?<!\\\\)${escapedDelimiter}([\\s\\S]+?)(?<!\\\\)${escapedDelimiter}`,
    "g"
  );
  const replacement = delimiter
    .split("")
    .map((char) => `\\${char}`)
    .join("");

  return text.replace(pairPattern, (match) =>
    match.replace(new RegExp(escapedDelimiter, "g"), replacement)
  );
}

function escapeUnpairedDelimiter(text: string, delimiter: string): string {
  const escapedDelimiter = escapeForRegex(delimiter);
  const pattern = new RegExp(`(?<!\\\\)${escapedDelimiter}`, "g");
  return text.replace(pattern, `\\${delimiter}`);
}

function escapeForRegex(value: string) {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}
