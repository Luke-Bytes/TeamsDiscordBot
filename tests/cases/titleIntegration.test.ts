import { test } from "../framework/test";
import { assert } from "../framework/assert";
import CaptainNominateCommand from "../../src/commands/CaptainNominate";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import { DraftTeamPickingSession } from "../../src/logic/teams/DraftTeamPickingSession";
import { Channels } from "../../src/Channels";
import { PlayerInstance } from "../../src/database/PlayerInstance";
import { Team } from "@prisma/client";
import { createChatInputInteraction } from "../framework/mocks";

function mkPlayer(
  id: string,
  ign: string,
  playerId: string,
  captain = false
): PlayerInstance {
  return {
    discordSnowflake: id,
    ignUsed: ign,
    playerId,
    captain,
    elo: 1000,
  } as PlayerInstance;
}

test("Captain nominate feed message includes title", async () => {
  const origSend = DiscordUtil.sendMessage;
  const origTitle = PrismaUtils.getDisplayNameWithTitle;
  const sent: string[] = [];
  (DiscordUtil as any).sendMessage = async (_chan: any, payload: any) => {
    sent.push(typeof payload === "string" ? payload : payload.content);
  };
  (PrismaUtils as any).getDisplayNameWithTitle = async (
    _playerId: string,
    baseName: string
  ) => `${baseName} the Champion`;

  try {
    const game = CurrentGameManager.getCurrentGame();
    game.reset();
    game.announced = true;
    (game as any).teams = {
      RED: [],
      BLUE: [],
      UNDECIDED: [mkPlayer("U1", "Alice", "P1")],
    };

    const cmd = new CaptainNominateCommand();
    const i = createChatInputInteraction("U1");
    await cmd.execute(i);

    const message = sent.find((m) => m.includes("nominated"));
    assert(!!message, "Nomination message sent");
    assert(message?.includes("the Champion"), "Nomination uses titled display");
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    (PrismaUtils as any).getDisplayNameWithTitle = origTitle;
  }
});

test("MVP announcement includes title", async () => {
  const origSend = DiscordUtil.sendMessage;
  const origTitle = PrismaUtils.getDisplayNameWithTitle;
  const sent: string[] = [];
  (DiscordUtil as any).sendMessage = async (_chan: any, payload: any) => {
    if (typeof payload === "string") sent.push(payload);
  };
  (PrismaUtils as any).getDisplayNameWithTitle = async (
    _playerId: string,
    baseName: string
  ) => `${baseName} the Champion`;

  try {
    const game = CurrentGameManager.getCurrentGame();
    game.reset();
    const red = mkPlayer("U1", "RedMvp", "P1");
    const blue = mkPlayer("U2", "BlueMvp", "P2");
    (game as any).teams = {
      RED: [red],
      BLUE: [blue],
      UNDECIDED: [],
    };
    (game as any).mvpVotes = {
      RED: { U1: 2 },
      BLUE: { U2: 3 },
    };

    await game.countMVPVotes();
    const message = sent.find((m) => m.includes("Game MVPs"));
    assert(!!message, "MVP announcement sent");
    assert(message?.includes("the Champion"), "MVP uses titled display");
  } finally {
    (DiscordUtil as any).sendMessage = origSend;
    (PrismaUtils as any).getDisplayNameWithTitle = origTitle;
  }
});

test("Draft pick and auto-assign messages include titles", async () => {
  const origTitle = PrismaUtils.getDisplayNameWithTitle;
  (PrismaUtils as any).getDisplayNameWithTitle = async (
    _playerId: string,
    baseName: string
  ) => `${baseName} the Champion`;

  const messages: string[] = [];
  Channels.teamPicking = {
    id: "TEAM_PICK",
    isSendable: () => true,
    messages: { fetch: async (_: any) => [] },
    send: async (payload: any) => {
      messages.push(typeof payload === "string" ? payload : payload.content);
      return {};
    },
  } as any;

  try {
    const session = new DraftTeamPickingSession("draft");
    const redCaptain = mkPlayer("RC", "RedCap", "PR", true);
    const blueCaptain = mkPlayer("BC", "BlueCap", "PB", true);
    const undecided = [
      mkPlayer("U1", "One", "P1"),
      mkPlayer("U2", "Two", "P2"),
    ];
    (session as any).proposedTeams = {
      RED: [redCaptain],
      BLUE: [blueCaptain],
      UNDECIDED: [...undecided],
    };
    (session as any).embedMessage = { edit: async () => {} };

    await (session as any).processPick(
      Team.RED,
      undecided[0],
      "UNDECIDED",
      "manual"
    );

    const pickMsg = messages.find((m) => m.includes("drafted"));
    assert(!!pickMsg, "Manual pick message sent");
    assert(pickMsg?.includes("the Champion"), "Pick uses titled display");

    const autoMsg = messages.find((m) => m.includes("automatically assigned"));
    assert(!!autoMsg, "Auto-assign message sent");
    assert(autoMsg?.includes("the Champion"), "Auto-assign uses title");
  } finally {
    (PrismaUtils as any).getDisplayNameWithTitle = origTitle;
  }
});
