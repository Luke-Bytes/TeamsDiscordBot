import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";
import { Channels } from "../../src/Channels";

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

test("Late Signups field shows only when even and pivot occurs after undecided empty", async () => {
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

  // Stub embed message to capture latest edit
  let lastEdit: any = null;
  session["embedMessage"] = {
    edit: async (payload: any) => {
      lastEdit = payload;
    },
  } as any;

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
  const message = {
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
    content: "LateOne",
    delete: async () => {},
  } as any;

  await session.handleMessage(message);

  // After picking one late, last remaining should auto-assign to other team
  assert(
    (session as any).lateSignups.length === 0,
    "Late pool empty after pick + auto-assign"
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
    "Auto-assigned late is on some team"
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
