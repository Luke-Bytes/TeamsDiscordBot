import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { FakeGuild, FakeGuildMember } from "../framework/mocks";
import { Channels } from "../../src/Channels";
import { withImmediateTimers } from "../framework/timers";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test("Captain 20m reminder posts to game-feed", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  const base = Date.now();
  game.startTime = new Date(base + 20 * 60 * 1000 + 10);

  const sent: any[] = [];
  const origSend = DiscordUtil.sendMessage;
  (DiscordUtil as any).sendMessage = async (
    channelKey: string,
    content: any
  ) => {
    sent.push({ channelKey, content });
  };

  const guild = new FakeGuild() as any;
  const origNow = Date.now;
  (Date as any).now = () => base;
  try {
    await withImmediateTimers(async () => {
      // Stub team picking channel for auto-start draft flow
      (Channels as any).teamPicking = {
        id: "teamPickingChannel",
        isSendable: () => true,
        send: async (_: any) => ({
          edit: async (_e: any) => {},
          embeds: [],
        }),
        messages: {
          fetch: async (_opts: any) => ({ find: (_cb: any) => undefined }),
        },
      } as any;
      CurrentGameManager.scheduleCaptainTimers(guild);
      await new Promise((r) => setImmediate(r));
    });
    const reminder = sent.find(
      (s) =>
        s.channelKey === "gameFeed" &&
        /Captains are still needed/i.test(String(s.content))
    );
    assert(!!reminder, "Should send 20m captains reminder to gameFeed");
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    (Date as any).now = origNow;
  }
});

test("Captain 15m enforcement auto-selects two captains and announces", async () => {
  const base = Date.now();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  // Registered players with ELO and presences
  const guild = new FakeGuild() as any;
  const p1 = new FakeGuildMember("u1050") as any;
  (p1 as any).presence = { status: "online" };
  const p2 = new FakeGuildMember("u1060") as any;
  (p2 as any).presence = { status: "idle" };
  const p3 = new FakeGuildMember("u1070") as any;
  (p3 as any).presence = { status: "dnd" };
  guild.addMember(p1);
  guild.addMember(p2);
  guild.addMember(p3);
  (game as any).teams = {
    RED: [],
    BLUE: [],
    UNDECIDED: [
      { discordSnowflake: "u1050", ignUsed: "P1050", elo: 1050 },
      { discordSnowflake: "u1060", ignUsed: "P1060", elo: 1060 },
      { discordSnowflake: "u1070", ignUsed: "P1070", elo: 1070 },
    ],
  };

  const sent: any[] = [];
  const origSend = DiscordUtil.sendMessage;
  (DiscordUtil as any).sendMessage = async (
    channelKey: string,
    content: any
  ) => {
    sent.push({ channelKey, content });
  };
  // Ensure captain role operations don't throw
  const origAssignRole = (DiscordUtil as any).assignRole;
  (DiscordUtil as any).assignRole = async () => {};

  // Make selection deterministic
  const origRand = Math.random;
  Math.random = () => 0; // pick first eligible as first

  const origNow = Date.now;
  game.startTime = new Date(base + 15 * 60 * 1000 + 10);
  (Date as any).now = () => base;
  try {
    await withImmediateTimers(async () => {
      CurrentGameManager.scheduleCaptainTimers(guild);
      await new Promise((r) => setImmediate(r));
    });
    const blueCap = game.getCaptainOfTeam("BLUE");
    const redCap = game.getCaptainOfTeam("RED");
    assert(!!blueCap && !!redCap, "Two captains should be auto-selected");
    assert(
      blueCap!.ignUsed === "P1050",
      "First captain should be P1050 (BLUE)"
    );
    assert(redCap!.ignUsed === "P1060", "Second captain should be P1060 (RED)");
    const announce = sent.find(
      (s) =>
        s.channelKey === "gameFeed" && /auto-selected/i.test(String(s.content))
    );
    assert(!!announce, "Should announce auto-selected captains to gameFeed");
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    (DiscordUtil as any).assignRole = origAssignRole;
    Math.random = origRand;
    (Date as any).now = origNow;
  }
});

test("Class-ban 1m reminders and deadline summary", async () => {
  const base = Date.now();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  game.setClassBanLimit(2); // one per captain
  // Set captains so reminder targets exist
  const redP = {
    discordSnowflake: "R1",
    ignUsed: "RedCap",
    elo: 1100,
    captain: true,
  } as any;
  const blueP = {
    discordSnowflake: "B1",
    ignUsed: "BlueCap",
    elo: 1110,
    captain: true,
  } as any;
  (game as any).teams = { RED: [redP], BLUE: [blueP], UNDECIDED: [] };

  const sent: any[] = [];
  const origSend = DiscordUtil.sendMessage;
  (DiscordUtil as any).sendMessage = async (
    channelKey: string,
    content: any
  ) => {
    sent.push({ channelKey, content });
  };

  const origNow = Date.now;
  // 1-minute reminders
  game.startTime = new Date(base + 60 * 1000 + 10);
  (Date as any).now = () => base;
  try {
    await withImmediateTimers(async () => {
      CurrentGameManager.scheduleClassBanTimers();
      await new Promise((r) => setImmediate(r));
    });
    const redReminder = sent.find(
      (s) =>
        s.channelKey === "redTeamChat" && /reminder/i.test(String(s.content))
    );
    const blueReminder = sent.find(
      (s) =>
        s.channelKey === "blueTeamChat" && /reminder/i.test(String(s.content))
    );
    assert(
      !!redReminder && !!blueReminder,
      "Should send last-minute class-ban reminders to both teams"
    );
  } finally {
    (Date as any).now = origNow;
  }

  // Deadline summary at start time
  sent.length = 0;
  (Date as any).now = () => base;
  game.startTime = new Date(base + 10);
  try {
    await withImmediateTimers(async () => {
      // Directly enforce to avoid timer dependency
      await CurrentGameManager.enforceClassBanDeadline();
    });
    const feedSummary = sent.find((s) => s.channelKey === "gameFeed");
    const redLock = sent.find(
      (s) =>
        s.channelKey === "redTeamChat" &&
        /window has closed/i.test(String(s.content))
    );
    const blueLock = sent.find(
      (s) =>
        s.channelKey === "blueTeamChat" &&
        /window has closed/i.test(String(s.content))
    );
    assert(
      !!redLock || !!blueLock || !!feedSummary,
      "Should enforce class-ban deadline with lockouts or summary"
    );
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    (Date as any).now = origNow;
  }
});
