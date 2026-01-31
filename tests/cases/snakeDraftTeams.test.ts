import { test } from "../framework/test";
import { assertEqual } from "../framework/assert";
import { Channels } from "../../src/Channels";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";
import { PlayerInstance } from "../../src/database/PlayerInstance";

function mkPlayer(id: string, ign: string, captain = false): PlayerInstance {
  return {
    discordSnowflake: id,
    ignUsed: ign,
    captain,
    elo: 1000,
  } as PlayerInstance;
}

function fakeChannel(id: string) {
  return {
    id,
    isSendable: () => true,
    messages: { fetch: async (_: any) => [] },
    send: async (_payload: any) => ({}),
  } as any;
}

test("Snake draft uses A-B-B-A order from red start", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession("snake");
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  const undecided = [
    mkPlayer("U1", "U1"),
    mkPlayer("U2", "U2"),
    mkPlayer("U3", "U3"),
    mkPlayer("U4", "U4"),
    mkPlayer("U5", "U5"),
    mkPlayer("U6", "U6"),
  ];

  session.redCaptain = redCaptain;
  session.blueCaptain = blueCaptain;
  session.turn = "RED";
  (session as any).firstPickTeam = "RED";
  (session as any).proposedTeams = {
    RED: [redCaptain],
    BLUE: [blueCaptain],
    UNDECIDED: [...undecided],
  };
  (session as any).embedMessage = { edit: async () => {} };

  await (session as any).processPick("RED", undecided[0], "UNDECIDED", "manual");
  assertEqual(session.turn, "BLUE", "Pick 1 -> BLUE");

  await (session as any).processPick(
    "BLUE",
    undecided[1],
    "UNDECIDED",
    "manual"
  );
  assertEqual(session.turn, "BLUE", "Pick 2 -> BLUE again");

  await (session as any).processPick(
    "BLUE",
    undecided[2],
    "UNDECIDED",
    "manual"
  );
  assertEqual(session.turn, "RED", "Pick 3 -> RED");

  await (session as any).processPick(
    "RED",
    undecided[3],
    "UNDECIDED",
    "manual"
  );
  assertEqual(session.turn, "RED", "Pick 4 -> RED again");
});

test("Snake draft uses A-B-B-A order from blue start", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession("snake");
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  const undecided = [
    mkPlayer("U1", "U1"),
    mkPlayer("U2", "U2"),
    mkPlayer("U3", "U3"),
    mkPlayer("U4", "U4"),
    mkPlayer("U5", "U5"),
    mkPlayer("U6", "U6"),
  ];

  session.redCaptain = redCaptain;
  session.blueCaptain = blueCaptain;
  session.turn = "BLUE";
  (session as any).firstPickTeam = "BLUE";
  (session as any).proposedTeams = {
    RED: [redCaptain],
    BLUE: [blueCaptain],
    UNDECIDED: [...undecided],
  };
  (session as any).embedMessage = { edit: async () => {} };

  await (session as any).processPick(
    "BLUE",
    undecided[0],
    "UNDECIDED",
    "manual"
  );
  assertEqual(session.turn, "RED", "Pick 1 -> RED");

  await (session as any).processPick(
    "RED",
    undecided[1],
    "UNDECIDED",
    "manual"
  );
  assertEqual(session.turn, "RED", "Pick 2 -> RED again");

  await (session as any).processPick(
    "RED",
    undecided[2],
    "UNDECIDED",
    "manual"
  );
  assertEqual(session.turn, "BLUE", "Pick 3 -> BLUE");
});

test("Snake draft keeps order when picking from late pool", async () => {
  Channels.teamPicking = fakeChannel("TEAM_PICK");
  const session = new DraftTeamPickingSession("snake");
  const redCaptain = mkPlayer("RC", "RedCap", true);
  const blueCaptain = mkPlayer("BC", "BlueCap", true);
  session.redCaptain = redCaptain;
  session.blueCaptain = blueCaptain;
  session.turn = "RED";
  (session as any).firstPickTeam = "RED";
  (session as any).proposedTeams = {
    RED: [redCaptain],
    BLUE: [blueCaptain],
    UNDECIDED: [],
  };
  (session as any).embedMessage = { edit: async () => {} };

  await session.registerLateSignup!(mkPlayer("L1", "LateOne"));
  await session.registerLateSignup!(mkPlayer("L2", "LateTwo"));

  const originalRandom = Math.random;
  Math.random = () => 0;
  await (session as any).executeAutoPick("RED");
  Math.random = originalRandom;

  assertEqual(session.turn, "BLUE", "Late pick 1 -> BLUE");
});
