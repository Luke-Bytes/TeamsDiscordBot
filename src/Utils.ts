import { GuildMember, PermissionResolvable, Client, Message } from "discord.js";
import { PlayerData } from "./database/PlayerData";
import { GameData } from "./database/GameData";

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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function isPlayerOnTeam(
  player: PlayerData,
  teamColor: "blue" | "red"
): boolean {
  const inGameName = player.getInGameName();
  console.log(`Checking if player ${inGameName} is on team ${teamColor}`);

  if (teamColor === "blue") {
    const isOnTeam = GameData.getBluePlayers().includes(inGameName);
    console.log(`Player ${inGameName} on blue team: ${isOnTeam}`);
    return isOnTeam;
  } else {
    const isOnTeam = GameData.getRedPlayers().includes(inGameName);
    console.log(`Player ${inGameName} on red team: ${isOnTeam}`);
    return isOnTeam;
  }
}

export function getCaptainByTeam(teamColor: "blue" | "red"): PlayerData | null {
  console.log(`Finding captain for ${teamColor} team.`);

  const captain = PlayerData.playerDataList.find(
    (player) => player.getIsCaptain() && isPlayerOnTeam(player, teamColor)
  );

  if (captain) {
    console.log(
      `Found captain for ${teamColor} team: ${captain.getInGameName()}`
    );
  } else {
    console.log(`No captain found for ${teamColor} team.`);
  }

  return captain ?? null;
}

export async function updateRoles(
  member,
  addRoles: string[],
  removeRoles: string[]
) {
  for (const role of removeRoles) {
    if (member.roles.cache.has(role)) {
      await member.roles
        .remove(role)
        .catch((error) =>
          console.error(
            `Failed to remove role ${role} from ${member.user.username}: ${error}`
          )
        );
    }
  }
  for (const role of addRoles) {
    if (!member.roles.cache.has(role)) {
      await member.roles
        .add(role)
        .catch((error) =>
          console.error(
            `Failed to add role ${role} to ${member.user.username}: ${error}`
          )
        );
    }
  }
}
