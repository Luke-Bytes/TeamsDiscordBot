import * as chrono from "chrono-node";
import { DateTime } from "luxon";

export const TIMESTAMP_TIMEZONES = [
  "GMT",
  "BST",
  "CET",
  "EST",
  "CST",
  "PST",
  "JST",
] as const;

export type TimestampTimezone = (typeof TIMESTAMP_TIMEZONES)[number];

const TZ_MAP: Record<TimestampTimezone, string> = {
  GMT: "Etc/GMT",
  BST: "Europe/London",
  CET: "Europe/Paris",
  EST: "America/New_York",
  CST: "America/Chicago",
  PST: "America/Los_Angeles",
  JST: "Asia/Tokyo",
};

export function parseDiscordTimestampInput(
  input: string | null,
  timezone?: string | null,
  now = new Date()
): { unix: number } | { error: string } {
  if (!input) {
    return { error: "Could not parse the date/time input." };
  }

  const trimmed = input.trim();
  const unixMatch = trimmed.match(/^(?:<t:)?(\d{1,13})(?::[tTdDfFR])?>?$/);

  if (unixMatch) {
    const parsed = Number(unixMatch[1]);
    if (Number.isSafeInteger(parsed)) {
      return {
        unix: parsed > 9_999_999_999 ? Math.floor(parsed / 1000) : parsed,
      };
    }
  }

  const tzKey = timezone?.toUpperCase() as TimestampTimezone | undefined;
  const tz = tzKey ? TZ_MAP[tzKey] : undefined;
  const parsed = chrono.parseDate(trimmed, now, { forwardDate: true });

  if (!parsed) {
    return { error: "Could not parse the date/time input." };
  }

  const base = DateTime.fromJSDate(parsed);
  let dt = base;
  if (tz) {
    const wall = {
      year: base.year,
      month: base.month,
      day: base.day,
      hour: base.hour,
      minute: base.minute,
      second: base.second,
      millisecond: 0,
    };
    dt = DateTime.fromObject(wall, { zone: tz });
  }

  if (!dt.isValid) {
    return { error: `Invalid timezone: ${tz}` };
  }

  return { unix: Math.floor(dt.toSeconds()) };
}
