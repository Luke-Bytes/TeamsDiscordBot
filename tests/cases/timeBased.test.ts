import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { FakeGuild, FakeGuildMember } from "../framework/mocks";
import { Channels } from "../../src/Channels";
import { withImmediateTimers } from "../framework/timers";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";
import { PlayerInstance } from "../../src/database/PlayerInstance";
import TeamCommand from "../../src/commands/TeamCommand";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mkPlayer(id: string, ign: string, captain = false) {
  return {
    discordSnowflake: id,
    ignUsed: ign,
    captain,
    elo: 1000,
  } as any;
}

function stubTeamPickingChannel(
  sent: string[],
  dms: string[]
): (typeof Channels)["teamPicking"] {
  return {
    id: "teamPickingChannel",
    isSendable: () => true,
    send: async (payload: any) => {
      const text =
        typeof payload === "string"
          ? payload
          : (payload?.content ?? "[non-text message]");
      sent.push(String(text ?? ""));
      return {
        delete: async () => {},
        edit: async () => {},
      } as any;
    },
    messages: {
      fetch: async () => ({
        find: () => undefined,
        filter: () => [],
      }),
    },
    client: {
      users: {
        fetch: async () => ({
          send: async (msg: string) => {
            dms.push(msg);
          },
        }),
      },
    },
  } as any;
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

test("Captain 20m reminder does not post when both captains already set", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  const base = Date.now();
  game.startTime = new Date(base + 20 * 60 * 1000 + 10);

  const redCap = {
    discordSnowflake: "R-CAP",
    ignUsed: "RedCap",
    elo: 1000,
    captain: true,
  } as any;
  const blueCap = {
    discordSnowflake: "B-CAP",
    ignUsed: "BlueCap",
    elo: 1000,
    captain: true,
  } as any;
  (game as any).teams = { RED: [redCap], BLUE: [blueCap], UNDECIDED: [] };

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
      CurrentGameManager.scheduleCaptainTimers(guild);
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
    });
    const reminder = sent.find(
      (s) =>
        s.channelKey === "gameFeed" &&
        /Captains are still needed/i.test(String(s.content))
    );
    assert(!reminder, "Should not send 20m captains reminder when both set");
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

test("Captain 15m enforcement auto-starts draft when captains already set and even", async () => {
  const base = Date.now();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();

  const redCap = {
    discordSnowflake: "R-CAP",
    ignUsed: "RedCap",
    elo: 1100,
    captain: true,
  } as any;
  const blueCap = {
    discordSnowflake: "B-CAP",
    ignUsed: "BlueCap",
    elo: 1120,
    captain: true,
  } as any;
  (game as any).teams = {
    RED: [redCap],
    BLUE: [blueCap],
    UNDECIDED: [mkPlayer("U1", "UndecidedOne"), mkPlayer("U2", "UndecidedTwo")],
  };

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
  game.startTime = new Date(base + 15 * 60 * 1000 + 10);
  (Date as any).now = () => base;

  const teamCommand = new TeamCommand();
  const origInit = DraftTeamPickingSession.prototype.initialize;
  let initCalled = false;
  DraftTeamPickingSession.prototype.initialize = async function (_i: any) {
    initCalled = true;
    this.state = "inProgress";
  };

  const originalChannel = Channels.teamPicking;
  Channels.teamPicking = stubTeamPickingChannel([], []);
  const originalRegistration = (Channels as any).registration;
  (Channels as any).registration = stubTeamPickingChannel([], []);

  try {
    await withImmediateTimers(async () => {
      CurrentGameManager.scheduleCaptainTimers(guild);
      await new Promise((r) => setImmediate(r));
    });
    assert(initCalled, "Draft session should initialize at 15m");
    assert(
      teamCommand.teamPickingSession instanceof DraftTeamPickingSession,
      "TeamCommand should hold the draft session"
    );
    const waitNotice = sent.find(
      (s) =>
        s.channelKey === "registration" &&
        /waiting 1 minute/i.test(String(s.content))
    );
    assert(!waitNotice, "Even count should not trigger wait notice");
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    DraftTeamPickingSession.prototype.initialize = origInit;
    Channels.teamPicking = originalChannel;
    (Channels as any).registration = originalRegistration;
    (Date as any).now = origNow;
    TeamCommand.instance = undefined;
  }
});

test("Captain 15m enforcement waits on odd players then removes last register", async () => {
  const base = Date.now();
  const game = CurrentGameManager.getCurrentGame();
  game.reset();

  const redCap = {
    discordSnowflake: "R-CAP",
    ignUsed: "RedCap",
    elo: 1100,
    captain: true,
  } as any;
  const blueCap = {
    discordSnowflake: "B-CAP",
    ignUsed: "BlueCap",
    elo: 1120,
    captain: true,
  } as any;
  (game as any).teams = {
    RED: [redCap],
    BLUE: [blueCap],
    UNDECIDED: [mkPlayer("U1", "UndecidedOne")],
  };
  game.lastRegisteredSnowflake = "U1";

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
  game.startTime = new Date(base + 15 * 60 * 1000 + 10);
  (Date as any).now = () => base;

  new TeamCommand();
  const origInit = DraftTeamPickingSession.prototype.initialize;
  let initCalled = false;
  DraftTeamPickingSession.prototype.initialize = async function (_i: any) {
    initCalled = true;
    this.state = "inProgress";
  };

  const originalChannel = Channels.teamPicking;
  Channels.teamPicking = stubTeamPickingChannel([], []);
  const originalRegistration = (Channels as any).registration;
  (Channels as any).registration = stubTeamPickingChannel([], []);

  try {
    await withImmediateTimers(async () => {
      CurrentGameManager.scheduleCaptainTimers(guild);
      let removalSeen = false;
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setImmediate(r));
        removalSeen = sent.some(
          (s) =>
            s.channelKey === "registration" &&
            /has been removed/i.test(String(s.content))
        );
        if (removalSeen) break;
      }
    });
    const waitNotice = sent.find(
      (s) =>
        s.channelKey === "registration" &&
        /waiting 1 minute/i.test(String(s.content))
    );
    const removalNotice = sent.find(
      (s) =>
        s.channelKey === "registration" &&
        /has been removed/i.test(String(s.content))
    );
    assert(!!waitNotice, "Odd count should trigger wait notice");
    assert(!!removalNotice, "Should announce auto-removal after wait");
    assert(initCalled, "Draft session should start after removal");
    assert(
      game.getPlayers().every((p: any) => p.discordSnowflake !== "U1"),
      "Last registered player should be removed"
    );
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    DraftTeamPickingSession.prototype.initialize = origInit;
    Channels.teamPicking = originalChannel;
    (Channels as any).registration = originalRegistration;
    (Date as any).now = origNow;
    TeamCommand.instance = undefined;
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
        /window has\s+(?:\*\*|__)?closed(?:\*\*|__)?/i.test(String(s.content))
    );
    const blueLock = sent.find(
      (s) =>
        s.channelKey === "blueTeamChat" &&
        /window has\s+(?:\*\*|__)?closed(?:\*\*|__)?/i.test(String(s.content))
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

test("Draft auto-pick fires after timeout using the eligible pool", async () => {
  const session = new DraftTeamPickingSession();
  (session as any).embedMessage = { edit: async () => {} };
  session.redCaptain = {
    discordSnowflake: "capR",
    captain: true,
  } as any;
  session.blueCaptain = {
    discordSnowflake: "capB",
    captain: true,
  } as any;
  session.proposedTeams.RED = [];
  session.proposedTeams.BLUE = [];
  session.proposedTeams.UNDECIDED = [
    { discordSnowflake: "p1", ignUsed: "Alpha" } as any,
    { discordSnowflake: "p2", ignUsed: "Bravo" } as any,
    { discordSnowflake: "p3", ignUsed: "Charlie" } as any,
  ];
  session.turn = "RED";

  const sentMessages: string[] = [];
  const dmMessages: string[] = [];
  const originalChannel = Channels.teamPicking;
  Channels.teamPicking = stubTeamPickingChannel(sentMessages, dmMessages);

  const originalSendTurnMessage = (session as any).sendTurnMessage;
  (session as any).sendTurnMessage = async () => {};

  const originalRandom = Math.random;
  Math.random = () => 0; // deterministically pick p1

  try {
    await withImmediateTimers(async () => {
      (session as any).startTurnTimer();
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert(
      session.proposedTeams.RED.some(
        (p: PlayerInstance) => p.discordSnowflake === "p1"
      ),
      "Auto pick should move the randomly selected player to the current team"
    );
    assert(
      !session.proposedTeams.UNDECIDED.some(
        (p: PlayerInstance) => p.discordSnowflake === "p1"
      ),
      "Auto-picked player must be removed from the undecided pool"
    );
    assert(
      sentMessages.some((msg) => /auto-picked/i.test(msg)),
      "Channel should announce the auto-pick"
    );
    assert(
      dmMessages.length === 1,
      "Opening pick should DM the captain with the one-minute reminder"
    );
  } finally {
    Math.random = originalRandom;
    Channels.teamPicking = originalChannel;
    if (originalSendTurnMessage) {
      (session as any).sendTurnMessage = originalSendTurnMessage;
    } else {
      delete (session as any).sendTurnMessage;
    }
  }
});

test("Draft cancel clears any pending auto-pick timers", async () => {
  const session = new DraftTeamPickingSession();
  (session as any).embedMessage = { delete: async () => {} };
  const sentMessages: string[] = [];
  const dmMessages: string[] = [];
  const originalChannel = Channels.teamPicking;
  Channels.teamPicking = stubTeamPickingChannel(sentMessages, dmMessages);

  let warningFired = false;
  let autoFired = false;
  let dmFired = false;

  (session as any).pickWarningTimeout = setTimeout(() => {
    warningFired = true;
  }, 10);
  (session as any).pickAutoTimeout = setTimeout(() => {
    autoFired = true;
  }, 15);
  (session as any).pickDmTimeout = setTimeout(() => {
    dmFired = true;
  }, 5);

  try {
    await session.cancelSession();
    await sleep(30);
    assert(!warningFired, "Warning timer should be cleared on cancel");
    assert(!autoFired, "Auto-pick timer should be cleared on cancel");
    assert(!dmFired, "DM timer should be cleared on cancel");
  } finally {
    Channels.teamPicking = originalChannel;
  }
});

test("Draft timers skip DM after the opening pick but still warn the channel", async () => {
  const session = new DraftTeamPickingSession();
  (session as any).embedMessage = { edit: async () => {} };
  session.redCaptain = {
    discordSnowflake: "capR",
    captain: true,
  } as any;
  session.blueCaptain = {
    discordSnowflake: "capB",
    captain: true,
  } as any;
  session.proposedTeams.RED = [];
  session.proposedTeams.BLUE = [];
  session.proposedTeams.UNDECIDED = [
    { discordSnowflake: "p1", ignUsed: "Alpha" } as any,
    { discordSnowflake: "p2", ignUsed: "Bravo" } as any,
    { discordSnowflake: "p3", ignUsed: "Charlie" } as any,
  ];
  session.turn = "RED";
  (session as any).pickCounts.RED = 1; // already made opening pick

  const sentMessages: string[] = [];
  const dmMessages: string[] = [];
  const originalChannel = Channels.teamPicking;
  Channels.teamPicking = stubTeamPickingChannel(sentMessages, dmMessages);

  const originalSendTurnMessage = (session as any).sendTurnMessage;
  (session as any).sendTurnMessage = async () => {};

  const originalRandom = Math.random;
  Math.random = () => 0;

  try {
    await withImmediateTimers(async () => {
      (session as any).startTurnTimer();
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert(
      dmMessages.length === 0,
      "Subsequent picks should not DM the captain"
    );
    assert(
      sentMessages.some((msg) => /15 seconds/i.test(msg)),
      "The turn warning should mention the 15 second threshold"
    );
  } finally {
    Math.random = originalRandom;
    Channels.teamPicking = originalChannel;
    if (originalSendTurnMessage) {
      (session as any).sendTurnMessage = originalSendTurnMessage;
    } else {
      delete (session as any).sendTurnMessage;
    }
  }
});
