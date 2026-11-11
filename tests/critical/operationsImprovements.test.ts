import { EmbedBuilder, MessageFlags } from "discord.js";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { gameFeed } from "../../src/logic/gameFeed/GameFeed";
import { GameInstance } from "../../src/database/GameInstance";
import { formatGameDiagnostics } from "../../src/logic/GameDiagnostics";
import GameCommand from "../../src/commands/GameCommand";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { createChatInputInteraction } from "../framework/mocks";

const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test("game feed publishes only changes, retries failed edits, recreates deleted messages, and clears removed state", async () => {
  const originalInterval = global.setInterval;
  const originalClear = global.clearInterval;
  let tick: (() => void) | undefined;
  (global as any).setInterval = (fn: () => void, ms: number) => {
    assertEqual(ms, 20000, "The update cadence must not change");
    tick = fn;
    return 991 as any;
  };
  (global as any).clearInterval = () => {};
  let title = "initial";
  let sendCount = 0;
  let editCount = 0;
  let failEdit = false;
  let deleted = false;
  const channel: any = {
    id: "feed-content-test",
    messages: {
      fetch: async (_id: string) => {
        if (deleted) throw new Error("Unknown Message");
        return {
          edit: async () => {
            editCount++;
            if (failEdit) {
              failEdit = false;
              throw new Error("temporary failure");
            }
          },
        };
      },
    },
    send: async () => {
      sendCount++;
      deleted = false;
      return { id: `published-${sendCount}`, delete: async () => {} };
    },
  };
  try {
    gameFeed.addFeedMessage(channel, "roster", async () => new EmbedBuilder().setTitle(title));
    await gameFeed.startFeed(channel);
    assertEqual(sendCount, 1, "Initial message is sent once");
    tick!();
    await flush();
    assertEqual(editCount, 0, "Equivalent embed needs no edit");

    title = "changed";
    tick!();
    await flush();
    assertEqual(editCount, 1, "Changed embed edits once");
    tick!();
    await flush();
    assertEqual(editCount, 1, "Successful publish is cached");

    title = "failed";
    failEdit = true;
    tick!();
    await flush();
    assertEqual(editCount, 2, "A failed edit is attempted");
    tick!();
    await flush();
    assertEqual(editCount, 3, "Failed content is retried");

    deleted = true;
    tick!();
    await flush();
    assertEqual(sendCount, 2, "Deleted message is recreated");
    tick!();
    await flush();
    assertEqual(editCount, 3, "Recreated content is recorded as published");

    gameFeed.removeFeedMessage(channel, "roster");
    gameFeed.addFeedMessage(channel, "roster", async () => new EmbedBuilder().setTitle(title));
    tick!();
    await flush();
    assertEqual(sendCount, 3, "Removing and readding resets cached identity");
    gameFeed.stopFeed(channel);
    gameFeed.addFeedMessage(channel, "roster", async () => new EmbedBuilder().setTitle(title));
    await gameFeed.startFeed(channel);
    assertEqual(sendCount, 4, "Stop clears the previous publication");
  } finally {
    gameFeed.stopFeed(channel);
    (global as any).setInterval = originalInterval;
    (global as any).clearInterval = originalClear;
  }
});

test("read-only diagnostics distinguish inactive, partial and started game state without guessing persistence", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  try {
    const inactive = formatGameDiagnostics(game);
    assert(inactive.includes("inactive"), "Inactive game shown");
    assert(inactive.includes("Unknown (not queried"), "Persistence is not inferred");
    const token = game.getLifecycleToken();
    game.announced = true;
    game.startTime = new Date("2030-01-02T20:00:00Z");
    game.teams.RED = [{ discordSnowflake: "r", captain: true } as any];
    game.teams.UNDECIDED = [{ discordSnowflake: "u" } as any];
    const partial = formatGameDiagnostics(game);
    assert(partial.includes("announced"), "Announcement visible");
    assert(partial.includes("RED 1, BLUE 0, UNDECIDED 1"), "Live team counts");
    assert(partial.includes("RED assigned, BLUE missing"), "Missing captain clearly reported");
    assert(partial.includes(token), "Fallback lifecycle correlation ID shown");
    assert(partial.includes("Unknown / not selected"), "Missing voting choices are explicit");
    assert(game.getGameStartStatus() === "idle", "Reading diagnostics does not start the game");
    game.tryBeginGameStart();
    assert(formatGameDiagnostics(game).includes("starting"), "Start in progress");
    game.completeGameStart();
    assert(formatGameDiagnostics(game).includes("started"), "Started game");
    game.isFinished = true;
    assert(formatGameDiagnostics(game).includes("finished"), "Finished game");
    game.isRestarting = true;
    assert(formatGameDiagnostics(game).includes("awaiting cleanup"), "Cleanup in progress");
  } finally {
    game.reset();
  }
});

test("/game diagnostics authorises organisers and responds ephemerally without changing state", async () => {
  const command = new GameCommand();
  const originalAuth = PermissionsUtil.isUserAuthorised;
  const game = GameInstance.getInstance();
  game.reset();
  try {
    let calls = 0;
    (PermissionsUtil as any).isUserAuthorised = async () => {
      calls++;
      return false;
    };
    const unauthorized = createChatInputInteraction("other", { subcommand: "diagnostics" }) as any;
    await command.execute(unauthorized);
    assertEqual(calls, 1, "Authorisation helper consulted");
    assertEqual(unauthorized.replies.length, 0, "Denied caller receives no diagnostic data");
    (PermissionsUtil as any).isUserAuthorised = async () => true;
    const permitted = createChatInputInteraction("organiser", { subcommand: "diagnostics" }) as any;
    const token = game.getLifecycleToken();
    await command.execute(permitted);
    const reply = permitted.replies[0]?.payload;
    assert(reply?.flags === MessageFlags.Ephemeral, "Diagnostics are ephemeral");
    assert(String(reply?.content).includes("Game diagnostics"), "Snapshot returned");
    assertEqual(game.getLifecycleToken(), token, "No lifecycle mutation");
  } finally {
    (PermissionsUtil as any).isUserAuthorised = originalAuth;
    game.reset();
  }
});
