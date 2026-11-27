import { APIEmbed, EmbedBuilder } from "discord.js";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { GameInstance } from "../../src/database/GameInstance";
import { gameFeed } from "../../src/logic/gameFeed/GameFeed";
import { addRegisteredPlayersFeed } from "../../src/logic/gameFeed/RegisteredGameFeed";
import { addTeamsGameFeed } from "../../src/logic/gameFeed/TeamsGameFeed";
import PerformanceCommand from "../../src/commands/PerformanceCommand";
import { MaintenanceLoggingUtil } from "../../src/util/MaintenanceLoggingUtil";
import { prismaClient } from "../../src/database/prismaClient";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("roster feeds reflect same-count changes, reset, and Discord embed limits", async () => {
  const game = GameInstance.getInstance();
  const oldInterval = global.setInterval;
  const oldClear = global.clearInterval;
  let tick: () => void = () => {};
  let edits = 0;
  const published = new Map<string, APIEmbed>();
  let sends = 0;
  const channel: any = {
    id: "quick-win-rosters",
    send: async ({ embeds }: any) => {
      const id = String(++sends);
      published.set(id, embeds[0].toJSON());
      return { id, delete: async () => published.delete(id) };
    },
    messages: {
      fetch: async ({ message }: { message: string }) => ({
        embeds: [new EmbedBuilder(published.get(message))],
      }),
      edit: async (id: string, { embeds }: any) => {
        edits++;
        published.set(id, embeds[0].toJSON());
      },
    },
  };
  const player = (id: string, elo = 1000, captain = false) =>
    ({ discordSnowflake: id, ignUsed: id, elo, captain }) as any;
  const update = async () => {
    tick();
    await flush();
  };
  (global as any).setInterval = (fn: () => void) => {
    tick = fn;
    return 111;
  };
  (global as any).clearInterval = () => {};
  game.reset();
  try {
    const a = player("Alpha", 1200, true);
    const b = player("Bravo", 1000);
    const c = player("Charlie", 800);
    const d = player("Delta", 900);
    game.teams.RED = [a, b];
    game.teams.BLUE = [c, d];
    game.lateSignups.add(d.discordSnowflake);
    await addRegisteredPlayersFeed(channel);
    await addTeamsGameFeed(channel);
    await gameFeed.startFeed(channel);
    assertEqual(sends, 2, "Both feeds are published");
    assert(published.get("1")?.fields?.[0].value.includes("Delta"), "Late signup displayed");
    assertEqual(published.get("2")?.fields?.[0].value, "Alpha\nBravo", "Captain first");
    await update();
    assertEqual(edits, 0, "Unchanged embeds are not edited");

    const replacement = player("Echo", 1400);
    game.teams.RED[1] = replacement;
    a.captain = false;
    replacement.captain = true;
    c.ignUsed = "Renamed";
    c.elo = 1100;
    game.teams.BLUE[1] = player("Foxtrot", 1100);
    game.lateSignups.delete(d.discordSnowflake);
    game.lateSignups.add("Foxtrot");
    await update();
    assert(published.get("1")?.description?.includes("Echo"), "Replacement appears");
    assert(!published.get("1")?.description?.includes("Bravo"), "Old player removed");
    assert(published.get("1")?.description?.includes("Renamed"), "IGN changes appear");
    assert(published.get("1")?.fields?.[0].value.includes("Foxtrot"), "Same-count late signup updated");
    assertEqual(published.get("2")?.fields?.[0].value, "Echo\nAlpha", "New captain first");
    assert(published.get("2")?.footer?.text.includes("Red Team: 1300"), "Red Elo updated");
    assert(published.get("2")?.footer?.text.includes("Blue Team: 1100"), "Blue Elo updated");

    game.teams.RED = [a, c];
    game.teams.BLUE = [replacement, game.teams.BLUE[1]];
    await update();
    assert(published.get("2")?.fields?.[0].value.includes("Renamed"), "Same-size swap updated");

    gameFeed.stopFeed(channel);
    game.reset();
    game.teams.RED = [player("NextRed"), player("NextRed2")];
    game.teams.BLUE = [player("NextBlue"), player("NextBlue2")];
    await addRegisteredPlayersFeed(channel);
    await addTeamsGameFeed(channel);
    await gameFeed.startFeed(channel);
    assert(published.get("3")?.description?.includes("NextRed"), "New game's registration list is fresh");
    assert(published.get("4")?.fields?.[0].value.includes("NextRed"), "New game's team list is fresh");

    game.teams.RED = [];
    game.teams.BLUE = [];
    await update();
    assertEqual(published.get("3")?.description, "No players have registered yet.", "Empty registration");
    assertEqual(published.get("4")?.fields?.[0].value, "No players", "Empty red team");
    assertEqual(published.get("4")?.fields?.[1].value, "No players", "Empty blue team");
    assert(published.get("4")?.footer?.text.includes("Red Team: 1000"), "Empty team Elo fallback");

    game.teams.RED = Array.from({ length: 300 }, (_, i) => player("RegularPlayer" + i));
    game.teams.BLUE = Array.from({ length: 100 }, (_, i) => player("LatePlayer" + i));
    for (const p of game.teams.BLUE) game.lateSignups.add(p.discordSnowflake);
    await update();
    assertEqual(published.get("3")?.description?.length, 4096, "Description includes fences within limit");
    assertEqual(published.get("3")?.fields?.[0].value.length, 1024, "Late signup field includes fences within limit");
    assert(published.get("3")?.fields?.[0].value.endsWith("...\n```"), "Truncated field closes code block");
    assertEqual(published.get("4")?.fields?.[0].value.length, 1024, "Team field respects limit");
  } finally {
    gameFeed.stopFeed(channel);
    game.reset();
    global.setInterval = oldInterval;
    global.clearInterval = oldClear;
  }
});

test("feed shutdown during a pending send removes the orphan", async () => {
  let finishSend!: (message: any) => void;
  let deleted = 0;
  let sends = 0;
  const pending = new Promise((resolve) => { finishSend = resolve; });
  const channel: any = {
    id: "quick-win-orphan",
    send: async () => {
      sends++;
      return pending;
    },
  };
  try {
    gameFeed.addFeedMessage(channel, "roster", async () => new EmbedBuilder().setTitle("Roster"));
    const startup = gameFeed.startFeed(channel);
    await flush();
    assertEqual(sends, 1, "Send is in flight");
    gameFeed.stopFeed(channel);
    finishSend({ id: "orphan", delete: async () => { deleted++; } });
    await startup;
    assertEqual(deleted, 1, "Orphan from stopped feed is deleted");
  } finally {
    gameFeed.stopFeed(channel);
  }
});

test("performance reports available HTTP evidence even if the database stalls", async () => {
  const oldFetch = global.fetch;
  const oldFind = prismaClient.player.findFirst;
  const oldSet = global.setTimeout;
  const oldClear = global.clearTimeout;
  const callbacks = new Map<number, () => void>();
  let id = 0;
  let finishDb!: () => void;
  let reply = "";
  const db = new Promise<void>((resolve) => { finishDb = resolve; });
  try {
    (prismaClient.player as any).findFirst = () => db;
    global.fetch = async () => new Response(null, { status: 204 });
    (global as any).setTimeout = (fn: () => void) => {
      callbacks.set(++id, fn);
      return id;
    };
    (global as any).clearTimeout = (timer: number) => callbacks.delete(timer);
    const execution = new PerformanceCommand().execute({
      client: { ws: { ping: 42 } },
      deferReply: async () => {},
      editReply: async (payload: any) => { reply = payload.content; },
    } as any);
    await flush();
    assertEqual(callbacks.size, 1, "Only database deadline remains");
    for (const fn of callbacks.values()) fn();
    await execution;
    assert(reply.includes("Database Latency:** Timed out"), "Deadline reported truthfully");
    assert(/Mojang API Ping:\*\* [\d.]+ ms/.test(reply), "Healthy HTTP result preserved");
    assertEqual(callbacks.size, 0, "Deadline released");
  } finally {
    finishDb();
    (prismaClient.player as any).findFirst = oldFind;
    global.fetch = oldFetch;
    global.setTimeout = oldSet;
    global.clearTimeout = oldClear;
  }
});

test("maintenance heartbeat schedules only once and does not claim Discord connectivity", () => {
  const originalTimeout = global.setTimeout;
  const originalInterval = global.setInterval;
  const originalInfo = console.info;
  const previousStarted = (MaintenanceLoggingUtil as any).started;
  let start!: () => void;
  let intervals = 0;
  let schedules = 0;
  const messages: string[] = [];
  try {
    (MaintenanceLoggingUtil as any).started = false;
    (global as any).setTimeout = (fn: () => void) => { start = fn; schedules++; return 1; };
    (global as any).setInterval = () => { intervals++; return 2; };
    console.info = (message: string) => { messages.push(message); };
    MaintenanceLoggingUtil.startLogging();
    MaintenanceLoggingUtil.startLogging();
    assertEqual(schedules, 1, "Only one initial schedule");
    start();
    assertEqual(intervals, 1, "Only one recurring schedule");
    assert(messages[0].includes("process heartbeat") && !messages[0].includes("online"), "Reports process, not network health");
  } finally {
    (MaintenanceLoggingUtil as any).started = previousStarted;
    global.setTimeout = originalTimeout;
    global.setInterval = originalInterval;
    console.info = originalInfo;
  }
});

test("performance checks start independently, isolate failures and release response bodies and timers", async () => {
  const oldFetch = global.fetch;
  const oldFind = prismaClient.player.findFirst;
  const oldSet = global.setTimeout;
  const oldClear = global.clearTimeout;
  const oldCpu = process.cpuUsage;
  const started: string[] = [];
  const timers = new Set<number>();
  let timerId = 0;
  let cancelCount = 0;
  let failDb!: (error: Error) => void;
  let failMojang!: (error: Error) => void;
  let finishGapple!: (response: Response) => void;
  const db = new Promise((_, reject) => { failDb = reject; });
  const mojang = new Promise<Response>((_, reject) => { failMojang = reject; });
  const gapple = new Promise<Response>((resolve) => { finishGapple = resolve; });
  let output = "";
  try {
    (prismaClient.player as any).findFirst = (args: any) => {
      assertEqual(JSON.stringify(args), '{"select":{"id":true}}', "Minimal DB projection");
      started.push("db");
      return db;
    };
    global.fetch = (async (url: string) => {
      if (url.includes("mojang")) {
        started.push("mojang");
        return mojang;
      }
      started.push("gapple");
      return gapple;
    }) as typeof fetch;
    (global as any).setTimeout = (_fn: () => void, delay: number) => {
      assertEqual(delay, 5000, "HTTP timeout preserved");
      timers.add(++timerId);
      return timerId;
    };
    (global as any).clearTimeout = (id: number) => timers.delete(id);
    process.cpuUsage = () => ({ user: 123456, system: 1000 });
    const command = new PerformanceCommand();
    const execution = command.execute({
      client: { ws: { ping: 42 } },
      deferReply: async () => {},
      editReply: async (payload: any) => { output = payload.content; },
    } as any);
    await flush();
    assertEqual(started.join(","), "db,mojang,gapple", "All independent checks start before results resolve");
    failDb(new Error("offline database"));
    failMojang(new Error("offline Mojang"));
    finishGapple(new Response(new ReadableStream({ cancel: () => { cancelCount++; } }), { status: 503 }));
    await execution;
    assert(output.includes("Database Latency:** Failed to connect\n"), "No misleading ms after failure");
    assert(output.includes("Mojang API Ping:** Failed to connect"), "Mojang failure isolated");
    assert(output.includes("Gapple API Status:** Error: 503"), "HTTP status displayed");
    assert(output.includes("Git Branch:**"), "Git result displayed");
    assert(output.includes("User: 123.46 ms"), "CPU microseconds converted to milliseconds");
    assertEqual(cancelCount, 1, "Unused body is cancelled on HTTP error");
    assertEqual(timers.size, 0, "HTTP timers cleared on both success and failure paths");
  } finally {
    (prismaClient.player as any).findFirst = oldFind;
    global.fetch = oldFetch;
    global.setTimeout = oldSet;
    global.clearTimeout = oldClear;
    process.cpuUsage = oldCpu;
  }
});
