import { GuildMember, PermissionResolvable, Client, Message } from 'discord.js';

export function formatDate(date: Date = new Date()): string {
  return date.toISOString().replace('T', ' ').split('.')[0];
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

export function hasPermissions(member: GuildMember, requiredPermissions: PermissionResolvable[]): boolean {
  return requiredPermissions.every(permission => member.permissions.has(permission));
}

export function parseArgs(input: string): string[] {
  return input.match(/"[^"]+"|\S+/g)?.map(arg => arg.replace(/(^"|"$)/g, '')) || [];
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function sanitizeInput(input: string): string {
  return input.replace(/[^a-zA-Z0-9 ]/g, '');
}

export function getEnvVariable(key: string, fallback: string = ''): string {
  return process.env[key] || fallback;
}

export function getUserIdFromMention(mention: string): string | null {
  const matches = mention.match(/^<@!?(\d+)>$/);
  return matches ? matches[1] : null;
}

export function truncateString(str: string, maxLength: number): string {
  return str.length > maxLength ? str.substring(0, maxLength - 3) + '...' : str;
}
