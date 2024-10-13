import { GuildMember, PermissionResolvable, Client, Message } from "discord.js";

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
export function randomEnum<T extends Object>(anEnum: T): T[keyof T] {
  const enumValues = Object.values(anEnum) as unknown as T[keyof T][];
  const randomIndex = Math.floor(Math.random() * enumValues.length);
  return enumValues[randomIndex];
}
