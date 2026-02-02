import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";
import { Channels } from "../../src/Channels";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ConfigManager } from "../../src/ConfigManager";

function mkPlayer(id: string, ign: string, captain = false) {
  return {
    discordSnowflake: id,
    ignUsed: ign,
    captain,
    elo: 1000,
  } as any;
}

function fakeChannel(id: string) {
  return {
    id,
    isSendable: () => true,
    messages: {
      fetch: async (_: any) => ({ find: (_f: any) => undefined }),
    },
    send: async (_: any) => ({}),
  } as any;
}

function captainMessage(captainId: string, content: string, channel?: any) {
  return {
    channel:
      channel ??
      ({
        id: "TEAM_PICK",
        isSendable: () => true,
        messages: { fetch: async (_: any) => [] },
        send: async (_: any) => ({}),
      } as any),
    author: { bot: false, id: captainId },
    mentions: {
      users: { values: () => ({ next: () => ({ value: undefined }) }) },
    },
    content,
    delete: async () => {},
  } as any;
}

test("Draft initialization cancels when undecided pool is odd", async () => {
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  const oddPlayer = mkPlayer("U1", "OddOne");
  const fakeGame = {
    teams: {
      RED: [redCaptain],
      BLUE: [blueCaptain],
      UNDECIDED: [oddPlayer],
    },
    getCaptainOfTeam: (team: string) =>
      team === "RED" ? redCaptain : blueCaptain,
  };
  const originalGet = CurrentGameManager.getCurrentGame;
  (CurrentGameManager as any).getCurrentGame = () => fakeGame;

  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession();
  const replies: string[] = [];
  const interaction = {
    editReply: async (payload: { content: string }) => {
      replies.push(payload.content);
    },
  } as any;

  await session.initialize(interaction);
  assertEqual(session.getState(), "cancelled", "Session should cancel");
  assert(
    replies.some((msg) => /even number/.test(msg)),
    "Notice about even players must be sent"
  );

  (CurrentGameManager as any).getCurrentGame = originalGet;
});

test("Initialize picks first team and schedules timers", async () => {
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  const undecided = [
    mkPlayer("U1", "UndecidedOne"),
    mkPlayer("U2", "UndecidedTwo"),
  ];
  const fakeGame = {
    teams: {
      RED: [redCaptain],
      BLUE: [blueCaptain],
      UNDECIDED: undecided,
    },
    getCaptainOfTeam: (team: string) =>
      team === "RED" ? redCaptain : blueCaptain,
  };
  const originalGet = CurrentGameManager.getCurrentGame;
  (CurrentGameManager as any).getCurrentGame = () => fakeGame;

  const sentMessages: any[] = [];
  const channel = {
    id: "TEAM_PICK",
    isSendable: () => true,
    messages: { fetch: async () => ({ find: () => undefined }) },
    send: async (payload: any) => {
      sentMessages.push(payload);
      return { edit: async () => {}, delete: async () => {} };
    },
    client: {
      users: {
        fetch: async () => ({
          send: async () => {},
        }),
      },
    },
  } as any;
  Channels.teamPicking = channel;

  const timeouts: number[] = [];
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  (global as any).setTimeout = (_fn: any, delay?: number) => {
    timeouts.push(delay ?? 0);
    return { id: delay } as any;
  };
  (global as any).clearTimeout = () => {};

  const originalRandom = Math.random;
  Math.random = () => 0.1; // Force RED pick

  const interaction = {
    editReply: async () => {},
  } as any;

  const session = new DraftTeamPickingSession();
  session.redCaptain = redCaptain;
  session.blueCaptain = blueCaptain;

  try {
    await session.initialize(interaction);

    assertEqual(
      session["turn"],
      "RED",
      "RED should pick first when random < 0.5"
    );
    assert(
      sentMessages.some((msg) =>
        (typeof msg === "string"
          ? msg
          : typeof msg?.content === "string"
            ? msg.content
            : ""
        ).includes("has been randomly picked to select first")
      ),
      "Channel should announce starting team"
    );
    assert(
      sentMessages.some((msg) =>
        (typeof msg === "string"
          ? msg
          : typeof msg?.content === "string"
            ? msg.content
            : ""
        ).includes(`<@${redCaptain.discordSnowflake}> It's your turn`)
      ),
      "Turn reminder should ping captain"
    );
    assertEqual(
      timeouts.length,
      3,
      "Warning, DM, and autopick timers should be scheduled"
    );
    assert(timeouts.includes(105000), "15 second warning scheduled");
    assert(timeouts.includes(60000), "DM warning scheduled");
    assert(timeouts.includes(120000), "Auto-pick scheduled");
  } finally {
    Math.random = originalRandom;
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
    (CurrentGameManager as any).getCurrentGame = originalGet;
  }
});

test("Late pool opens only after undecided empty and remains pickable until both consumed", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession();
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  session.redCaptain = redCaptain;
  session.blueCaptain = blueCaptain;
  session.turn = "RED" as const;
  session["proposedTeams"] = {
    RED: [redCaptain],
    BLUE: [blueCaptain],
    UNDECIDED: [mkPlayer("U1", "UndecidedOne"), mkPlayer("U2", "UndecidedTwo")],
  } as any;

  // Stub embed message to capture latest edit
  let lastEdit: any = null;
  session["embedMessage"] = {
    edit: async (payload: any) => {
      lastEdit = payload;
    },
  } as any;

  // Consume undecided pool
  await session.handleMessage(
    captainMessage(redCaptain.discordSnowflake, "UndecidedOne")
  );

  // Register two late signups (even)
  const late1 = mkPlayer("L1", "LateOne");
  const late2 = mkPlayer("L2", "LateTwo");
  await session.registerLateSignup!(late1);
  await session.registerLateSignup!(late2);

  // Verify embed includes Late Signups with 2 entries
  const fields = lastEdit?.embeds?.[0]?.data?.fields ?? [];
  const lateField = fields.find((f: any) => /Late Signups/i.test(f.name));
  assert(!!lateField, "Late Signups field present for even count");
  const val = String(lateField.value || "");
  assert(
    val.includes("LateOne") && val.includes("LateTwo"),
    "Late names appear"
  );

  // Since undecided is empty and even late signups available, picking should pivot to late pool
  await session.handleMessage(
    captainMessage(redCaptain.discordSnowflake, "LateOne")
  );

  // After picking one late, remaining late signup should still be available for the next captain
  assert(
    (session as any).lateSignups.length === 1,
    "Late pool keeps remaining signup available"
  );
  assertEqual(
    (session as any)["turn"],
    "BLUE",
    "Turn should hand off to the other captain"
  );

  await session.handleMessage(
    captainMessage(blueCaptain.discordSnowflake, "LateTwo")
  );

  assert(
    (session as any).lateSignups.length === 0,
    "Late pool empty after both picks"
  );
  const redNames = (session as any).proposedTeams.RED.map(
    (p: any) => p.ignUsed
  ).join(",");
  const blueNames = (session as any).proposedTeams.BLUE.map(
    (p: any) => p.ignUsed
  ).join(",");
  assert(
    redNames.includes("LateOne") || blueNames.includes("LateOne"),
    "Picked late is on some team"
  );
  assert(
    redNames.includes("LateTwo") || blueNames.includes("LateTwo"),
    "Second late signup manually picked onto a team"
  );
});

test("Finalization accept updates teams and finalizes game", async () => {
  const organiserRole = "ORG_ROLE";
  const originalConfig = ConfigManager.getConfig;
  (ConfigManager as any).getConfig = () => ({
    roles: { organiserRole },
  });
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  const redPlayers = [redCaptain, mkPlayer("R1", "RedOne")];
  const bluePlayers = [blueCaptain, mkPlayer("B1", "BlueOne")];
  const undecided = [mkPlayer("U1", "UndecidedOne")];
  const fakeGame = {
    teams: {
      RED: [],
      BLUE: [],
      UNDECIDED: [...undecided],
    },
    getCaptainOfTeam: (team: string) =>
      team === "RED" ? redCaptain : blueCaptain,
    changeHowTeamsDecided: () => {},
  };
  const originalGet = CurrentGameManager.getCurrentGame;
  (CurrentGameManager as any).getCurrentGame = () => fakeGame;

  const channelMessages: string[] = [];
  const channel = {
    isSendable: () => true,
    send: async (payload: any) => {
      if (typeof payload === "string") channelMessages.push(payload);
      return {};
    },
  } as any;
  const finalizeEditPayloads: any[] = [];
  const deferred: string[] = [];
  const interaction = {
    customId: "draft-accept",
    user: { id: "123" },
    channel,
    guild: {
      members: {
        cache: new Map([
          [
            "123",
            {
              roles: { cache: new Map([[organiserRole, true]]) },
            },
          ],
        ]),
      },
    },
    deferUpdate: async () => {
      deferred.push("ok");
    },
  } as any;

  const session = new DraftTeamPickingSession();
  session.proposedTeams = {
    RED: redPlayers.slice(),
    BLUE: bluePlayers.slice(),
    UNDECIDED: [],
  };
  session.finishedPicking = true;
  session.finalizeMessage = {
    edit: async (payload: any) => {
      finalizeEditPayloads.push(payload);
    },
  } as any;
  session.embedMessage = { delete: async () => {} } as any;

  await session.handleInteraction(interaction as any);

  assert(deferred.length === 1, "Interaction should defer update");
  assertEqual(fakeGame.teams.RED.length, redPlayers.length, "Red team copied");
  assertEqual(
    fakeGame.teams.BLUE.length,
    bluePlayers.length,
    "Blue team copied"
  );
  assertEqual(
    session.getState(),
    "finalized",
    "Session state set to finalized after accept"
  );
  assert(
    channelMessages.some((msg) => /Teams have been finalised/i.test(msg)),
    "Confirmation message should be sent"
  );
  assert(
    finalizeEditPayloads.length === 1 &&
      finalizeEditPayloads[0].components.length === 0,
    "Finalize message buttons removed"
  );

  (ConfigManager as any).getConfig = originalConfig;
  (CurrentGameManager as any).getCurrentGame = originalGet;
});

test("Draft cancel button removes embed and cancels session", async () => {
  const organiserRole = "ORG_ROLE";
  const originalConfig = ConfigManager.getConfig;
  (ConfigManager as any).getConfig = () => ({
    roles: { organiserRole },
  });
  const interaction = {
    customId: "draft-cancel",
    user: { id: "123" },
    channel: {
      isSendable: () => true,
      send: async () => {},
    },
    guild: {
      members: {
        cache: new Map([
          [
            "123",
            {
              roles: { cache: new Map([[organiserRole, true]]) },
            },
          ],
        ]),
      },
    },
    deferUpdate: async () => {},
  } as any;
  const session = new DraftTeamPickingSession();
  session.finishedPicking = true;
  let embedDeleted = false;
  session.embedMessage = {
    delete: async () => {
      embedDeleted = true;
    },
  } as any;

  await session.handleInteraction(interaction as any);
  assert(embedDeleted, "Embed should be deleted on cancel");
  assertEqual(session.getState(), "cancelled", "Session should cancel");

  (ConfigManager as any).getConfig = originalConfig;
});

test("Auto-pick reports when no eligible players remain", async () => {
  const sent: string[] = [];
  Channels.teamPicking = {
    isSendable: () => true,
    send: async (payload: string) => {
      sent.push(payload);
      return {};
    },
  } as any;
  const session = new DraftTeamPickingSession();
  session.turn = "RED";
  session.state = "inProgress";
  session.proposedTeams = { RED: [], BLUE: [], UNDECIDED: [] };
  session["lateSignups"] = [];
  session["lateDraftableWindow"] = 0;

  await (session as any).executeAutoPick("RED");

  assert(
    sent.some((msg) => /No eligible players remain/i.test(msg)),
    "Channel should be warned when no pool exists"
  );
});

test("Odd late count does not show section; becomes visible when even", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession();
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  session.redCaptain = redCaptain;
  session.blueCaptain = blueCaptain;
  session.turn = "RED" as const;
  session["proposedTeams"] = {
    RED: [redCaptain],
    BLUE: [blueCaptain],
    UNDECIDED: [],
  } as any;

  let lastEdit: any = null;
  session["embedMessage"] = { edit: async (p: any) => (lastEdit = p) } as any;

  await session.registerLateSignup!(mkPlayer("L1", "LateOne"));
  let fields = lastEdit?.embeds?.[0]?.data?.fields ?? [];
  let lateField = fields.find((f: any) => /Late Signups/i.test(f.name));
  assert(!lateField, "No Late Signups section for odd count");

  await session.registerLateSignup!(mkPlayer("L2", "LateTwo"));
  fields = lastEdit?.embeds?.[0]?.data?.fields ?? [];
  lateField = fields.find((f: any) => /Late Signups/i.test(f.name));
  assert(!!lateField, "Late Signups appears when even count reached");
});

test("Auto-pick consumes eligible late players and finalises", async () => {
  const sentMessages: string[] = [];
  Channels.teamPicking = {
    id: "TEAM_PICK",
    isSendable: () => true,
    messages: { fetch: async (_: any) => ({ find: () => undefined }) },
    send: async (payload: any) => {
      if (typeof payload === "string") {
        sentMessages.push(payload);
      } else if (payload?.content) {
        sentMessages.push(payload.content);
      }
      return {};
    },
  } as any;
  const session = new DraftTeamPickingSession();
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  session.redCaptain = redCaptain;
  session.blueCaptain = blueCaptain;
  session.turn = "RED";
  session["proposedTeams"] = {
    RED: [redCaptain],
    BLUE: [blueCaptain],
    UNDECIDED: [],
  } as any;
  session["embedMessage"] = { edit: async () => {} } as any;

  const late1 = mkPlayer("L1", "LateOne");
  const late2 = mkPlayer("L2", "LateTwo");
  await session.registerLateSignup!(late1);
  await session.registerLateSignup!(late2);

  const originalRandom = Math.random;
  Math.random = () => 0;
  await (session as any).executeAutoPick("RED");
  Math.random = originalRandom;

  assert(
    (session as any).lateSignups.length === 1,
    "One late signup remains after auto pick"
  );
  assertEqual(
    (session as any).turn,
    "BLUE",
    "Turn rotates to other team after auto pick"
  );

  await (session as any).executeAutoPick("BLUE");
  assert(
    (session as any).lateSignups.length === 0,
    "Auto pick consumes final late signup"
  );
  assert(session.finishedPicking, "Draft finalises after auto picks");
  assert(
    sentMessages.some((msg) => msg.includes("All players have been drafted")),
    "Finalisation message should be sent"
  );
});

test("Odd leftover late signup remains undecided when draft finalises", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession();
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  const undecidedOne = mkPlayer("U1", "UndecidedOne");
  const undecidedTwo = mkPlayer("U2", "UndecidedTwo");
  const lateOdd = mkPlayer("L3", "LateOdd");
  session.redCaptain = redCaptain;
  session.blueCaptain = blueCaptain;
  session.turn = "RED" as const;
  session["proposedTeams"] = {
    RED: [redCaptain],
    BLUE: [blueCaptain],
    UNDECIDED: [undecidedOne, undecidedTwo],
  } as any;
  session["embedMessage"] = { edit: async () => {} } as any;

  await session.registerLateSignup!(lateOdd);

  const firstPick = {
    channel: {
      id: "TEAM_PICK",
      isSendable: () => true,
      messages: { fetch: async (_: any) => [] },
      send: async (_: any) => ({}),
    },
    author: { bot: false, id: redCaptain.discordSnowflake },
    mentions: {
      users: { values: () => ({ next: () => ({ value: undefined }) }) },
    },
    content: "UndecidedOne",
    delete: async () => {},
  } as any;

  await session.handleMessage(firstPick);

  const secondPick = {
    ...firstPick,
    author: { bot: false, id: blueCaptain.discordSnowflake },
    content: "UndecidedTwo",
  };

  await session.handleMessage(secondPick);

  assert(
    session.finishedPicking,
    "Draft should finish once undecided exhausted"
  );
  const undecidedNames = (session as any).proposedTeams.UNDECIDED.map(
    (p: any) => p.ignUsed
  );
  assert(
    undecidedNames.includes("LateOdd"),
    "Remaining late signup moved back to undecided pool"
  );
  assert(
    (session as any).lateSignups.length === 0,
    "Late signup queue cleared after finalisation"
  );
});

test("Late signups registered after late picking begins are ignored", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession();
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  session.redCaptain = redCaptain;
  session.blueCaptain = blueCaptain;
  session.turn = "RED";
  session["proposedTeams"] = {
    RED: [redCaptain],
    BLUE: [blueCaptain],
    UNDECIDED: [],
  } as any;
  session["embedMessage"] = { edit: async () => {} } as any;

  const late1 = mkPlayer("L1", "LateOne");
  const late2 = mkPlayer("L2", "LateTwo");
  const late3 = mkPlayer("L3", "LateThree");
  await session.registerLateSignup!(late1);
  await session.registerLateSignup!(late2);

  await session.handleMessage(
    captainMessage(redCaptain.discordSnowflake, "LateOne")
  );

  const beforeLength = (session as any).lateSignups.length;
  await session.registerLateSignup!(late3);
  assertEqual(
    (session as any).lateSignups.length,
    beforeLength,
    "Additional late signup ignored once late picking started"
  );
});

test("Late signup left over is not duplicated in registered counts", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession();
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  const undecidedOne = mkPlayer("U1", "UndecidedOne");
  const lateOdd = mkPlayer("L3", "LateOdd");
  session.redCaptain = redCaptain;
  session.blueCaptain = blueCaptain;
  session.turn = "RED";
  session["proposedTeams"] = {
    RED: [redCaptain],
    BLUE: [blueCaptain],
    UNDECIDED: [undecidedOne],
  } as any;
  session["embedMessage"] = { edit: async () => {} } as any;

  await session.registerLateSignup!(lateOdd);

  session["finishedPicking"] = true;
  await (session as any).handleRemainingLateSignups(Channels.teamPicking);

  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  (game as any).teams = {
    RED: session["proposedTeams"].RED,
    BLUE: session["proposedTeams"].BLUE,
    UNDECIDED: session["proposedTeams"].UNDECIDED,
  };

  const lateSet = new Set(
    game.getPlayersOfTeam("UNDECIDED").map((p) => p.discordSnowflake)
  );
  assertEqual(
    lateSet.size,
    game.getPlayersOfTeam("UNDECIDED").length,
    "UNDECIDED list should not contain duplicate late signup entries"
  );
});

test("Unregister during draft opens a late signup slot", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession();
  const undecided = mkPlayer("U1", "UndecidedOne");
  const lateOne = mkPlayer("L1", "LateOne");
  session["proposedTeams"] = {
    RED: [],
    BLUE: [],
    UNDECIDED: [undecided],
  } as any;
  session["lateSignups"] = [lateOne];
  session["lateDraftableWindow"] = 0;
  session["embedMessage"] = { edit: async () => {} } as any;

  await session.handleUnregister(undecided.discordSnowflake);

  assertEqual(
    session["proposedTeams"].UNDECIDED.length,
    0,
    "Unregistered player removed from undecided pool"
  );
  assertEqual(
    (session as any).getLateDraftablePlayers().length,
    1,
    "Late signup should be allowed after unregister"
  );
});

test("Unregistering unknown player does not change draft pools", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession();
  const undecidedOne = mkPlayer("U1", "UndecidedOne");
  const undecidedTwo = mkPlayer("U2", "UndecidedTwo");
  const lateOne = mkPlayer("L1", "LateOne");
  const lateTwo = mkPlayer("L2", "LateTwo");
  session["proposedTeams"] = {
    RED: [],
    BLUE: [],
    UNDECIDED: [undecidedOne, undecidedTwo],
  } as any;
  session["lateSignups"] = [lateOne, lateTwo];
  session["lateDraftableWindow"] = 2;
  session["embedMessage"] = { edit: async () => {} } as any;

  await session.handleUnregister("MISSING");

  assertEqual(
    session["proposedTeams"].UNDECIDED.length,
    2,
    "Undecided pool unchanged"
  );
  assertEqual(
    (session as any).getLateDraftablePlayers().length,
    2,
    "Late signup window unchanged"
  );
});

test("Unregistering drafted player allows odd late signups", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession();
  const drafted = mkPlayer("D1", "DraftedOne");
  const lateOne = mkPlayer("L1", "LateOne");
  const lateTwo = mkPlayer("L2", "LateTwo");
  const lateThree = mkPlayer("L3", "LateThree");
  session["proposedTeams"] = {
    RED: [drafted],
    BLUE: [],
    UNDECIDED: [],
  } as any;
  session["lateSignups"] = [lateOne, lateTwo, lateThree];
  session["lateDraftableWindow"] = 2;
  session["embedMessage"] = { edit: async () => {} } as any;

  await session.handleUnregister(drafted.discordSnowflake);

  assert(
    !session["proposedTeams"].RED.some(
      (p: any) => p.discordSnowflake === drafted.discordSnowflake
    ),
    "Drafted player removed from team"
  );
  assertEqual(
    (session as any).getLateDraftablePlayers().length,
    3,
    "Odd late signups allowed after unregister"
  );
});

test("Unregistering late signup removes them without bonus slot", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession();
  const lateOne = mkPlayer("L1", "LateOne");
  const lateTwo = mkPlayer("L2", "LateTwo");
  session["proposedTeams"] = {
    RED: [],
    BLUE: [],
    UNDECIDED: [],
  } as any;
  session["lateSignups"] = [lateOne, lateTwo];
  session["lateDraftableWindow"] = 2;
  session["embedMessage"] = { edit: async () => {} } as any;

  await session.handleUnregister(lateOne.discordSnowflake);

  assertEqual(
    (session as any).lateSignups.length,
    1,
    "Late signup removed from queue"
  );
  assertEqual(
    (session as any).getLateDraftablePlayers().length,
    0,
    "Late signup window collapses to even count without bonus"
  );
});
