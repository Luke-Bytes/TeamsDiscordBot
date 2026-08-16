import { test } from "../framework/test";
import { assert } from "../framework/assert";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import GameCommand from "../../src/commands/GameCommand";
import AnnouncementCommand from "../../src/commands/AnnouncementCommand";
import RegisterCommand from "../../src/commands/RegisterCommand";
import UnregisterCommand from "../../src/commands/UnregisterCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import { GameInstance } from "../../src/database/GameInstance";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { ConfigManager } from "../../src/ConfigManager";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { MojangAPI } from "../../src/api/MojangAPI";
import { prismaClient } from "../../src/database/prismaClient";

function player(id: string) {
  return {
    discordSnowflake: id,
    ignUsed: id,
    latestIGN: id,
    playerId: `db-${id}`,
    primaryMinecraftAccount: `uuid-${id}`,
    minecraftAccounts: [id],
    elo: 1000,
    captain: false,
  } as any;
}

function replyText(interaction: { replies: any[] }): string {
  const payload = interaction.replies.at(-1)?.payload;
  return String(typeof payload === "string" ? payload : payload?.content);
}

async function gameEndInteraction() {
  const config = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;
  const organiser = new FakeGuildMember("lifecycle-organiser");
  await organiser.roles.add(config.roles.organiserRole);
  guild.addMember(organiser);
  const interaction = createChatInputInteraction(organiser.id, {
    guild,
    member: organiser as any,
    subcommand: "end",
  });
  return { guild, interaction };
}

test("/game end rejects every non-playable lifecycle state without side effects", async () => {
  const game = GameInstance.getInstance();
  const command = new GameCommand();
  const originalSend = DiscordUtil.sendMessage;
  let messagesSent = 0;
  (DiscordUtil as any).sendMessage = async () => {
    messagesSent++;
  };

  try {
    const cases = [
      {
        prepare: () => {},
        expected: /no game has been announced/i,
      },
      {
        prepare: () => {
          game.announced = true;
        },
        expected: /team picking is finalized/i,
      },
      {
        prepare: () => {
          game.announced = true;
          game.teamsDecidedBy = "RANDOMISED";
          game.teams.RED.push(player("red-only"));
        },
        expected: /at least one player on both/i,
      },
      {
        prepare: () => {
          game.announced = true;
          game.isFinished = true;
        },
        expected: /already ended/i,
      },
      {
        prepare: () => {
          game.announced = true;
          game.isRestarting = true;
        },
        expected: /shutdown is already in progress/i,
      },
    ];

    for (const lifecycleCase of cases) {
      game.reset();
      lifecycleCase.prepare();
      const before = JSON.stringify({
        announced: game.announced,
        isFinished: game.isFinished,
        isRestarting: game.isRestarting,
        teamsDecidedBy: game.teamsDecidedBy,
        red: game.teams.RED.map((p) => p.discordSnowflake),
        blue: game.teams.BLUE.map((p) => p.discordSnowflake),
      });
      const { interaction } = await gameEndInteraction();

      await command.execute(interaction);

      assert(
        lifecycleCase.expected.test(replyText(interaction)),
        `Expected actionable rejection matching ${lifecycleCase.expected}`
      );
      assert(
        JSON.stringify({
          announced: game.announced,
          isFinished: game.isFinished,
          isRestarting: game.isRestarting,
          teamsDecidedBy: game.teamsDecidedBy,
          red: game.teams.RED.map((p) => p.discordSnowflake),
          blue: game.teams.BLUE.map((p) => p.discordSnowflake),
        }) === before,
        "Rejected /game end must leave lifecycle state untouched"
      );
    }
    assert(messagesSent === 0, "Rejected /game end must not send MVP messages");
  } finally {
    (DiscordUtil as any).sendMessage = originalSend;
    game.reset();
  }
});

test("/game end accepts finalized populated RED and BLUE teams", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  game.announced = true;
  game.teamsDecidedBy = "RANDOMISED";
  game.teams.RED.push(player("red"));
  game.teams.BLUE.push(player("blue"));

  const originalSend = DiscordUtil.sendMessage;
  (DiscordUtil as any).sendMessage = async () => {};
  try {
    const { interaction } = await gameEndInteraction();
    await new GameCommand().execute(interaction);
    assert(game.isFinished === true, "Playable finalized game should end");
    assert(
      /moving players back/i.test(replyText(interaction)),
      "Valid end should begin the normal MVP flow"
    );
  } finally {
    (DiscordUtil as any).sendMessage = originalSend;
    game.reset();
  }
});

test("confirmed announcement transition preserves configuration and clears stale results", () => {
  const game = GameInstance.getInstance();
  game.reset();
  const startTime = new Date("2030-01-02T19:00:00Z");
  const mapVoteManager = { marker: "new-map-vote" } as any;
  const previewMessage = { id: "new-preview" } as any;
  game.startTime = startTime;
  game.settings.map = "DUELSTAL";
  game.settings.modifiers = [{ category: "Test", name: "Enabled" }];
  game.settings.organiserBannedClasses = ["ACROBAT"];
  game.organiser = "New Organiser";
  game.host = "New Host";
  game.isDoubleElo = true;
  game.mapVoteManager = mapVoteManager;
  game.announcementPreviewMessage = previewMessage;

  game.isFinished = true;
  game.isRestarting = true;
  game.gameWinner = "RED";
  game.gameId = "stale-game";
  game.endTime = new Date();
  game.teamsDecidedBy = "RANDOMISED";
  game.teams.RED.push(player("stale-red"));
  game.teams.BLUE.push(player("stale-blue"));
  game.lateSignups.add("stale-late");
  game.MVPPlayerRed = "Old MVP";
  game.mvpVotes.RED["stale-red"] = 5;
  game.blueMeanElo = 1400;

  game.beginConfirmedAnnouncement();

  assert(game.announced, "New announcement should be active");
  assert(game.isFinished === false, "Stale finished flag should be cleared");
  assert(!game.isRestarting, "Stale shutdown flag should be cleared");
  assert(
    !game.gameWinner && !game.gameId && !game.endTime,
    "Old result identity should clear"
  );
  assert(game.getPlayers().length === 0, "Old players should clear");
  assert(game.teamsDecidedBy === null, "Old team finalization should clear");
  assert(game.lateSignups.size === 0, "Old late signups should clear");
  assert(
    game.mvpVotes.RED["stale-red"] === undefined,
    "Old MVP votes should clear"
  );
  assert(game.blueMeanElo === undefined, "Old Elo results should clear");
  assert(game.startTime === startTime, "Prepared start time should remain");
  assert(game.settings.map === "DUELSTAL", "Prepared map should remain");
  assert(
    game.settings.modifiers.length === 1,
    "Prepared modifiers should remain"
  );
  assert(
    game.settings.organiserBannedClasses[0] === "ACROBAT",
    "Prepared organiser bans should remain"
  );
  assert(
    game.organiser === "New Organiser" && game.host === "New Host",
    "Prepared staff should remain"
  );
  assert(game.isDoubleElo, "Prepared double-Elo selection should remain");
  assert(
    game.mapVoteManager === mapVoteManager,
    "Prepared vote manager should remain"
  );
  assert(
    game.announcementPreviewMessage === previewMessage,
    "Prepared messages should remain"
  );
  game.reset();
});

test("stale announcement Cancel button is rejected after teams finalize", async () => {
  const game = GameInstance.getInstance();
  const command = new AnnouncementCommand();
  const guild = new FakeGuild() as any;
  const originalCancel = CurrentGameManager.cancelCurrentGame;
  let cancellations = 0;
  (CurrentGameManager as any).cancelCurrentGame = async () => {
    cancellations++;
    game.reset();
  };

  const pressCancel = async () => {
    let response = "";
    await command.handleButtonPress({
      customId: "announcement-cancel",
      guild,
      deferReply: async () => {},
      editReply: async (value: any) => {
        response = String(value?.content ?? value);
      },
    } as any);
    return response;
  };

  try {
    game.reset();
    game.announced = true;
    assert(
      /cancelled announcement/i.test(await pressCancel()),
      "Cancel should work before finalization"
    );
    assert(
      cancellations === 1,
      "Pre-finalization Cancel should reset the game"
    );

    game.announced = true;
    game.settings.map = "DUELSTAL";
    game.teamsDecidedBy = "RANDOMISED";
    game.teams.RED.push(player("red"));
    game.teams.BLUE.push(player("blue"));
    const response = await pressCancel();
    assert(
      /can no longer be cancelled/i.test(response),
      "Stale Cancel should explain the rejection"
    );
    assert(
      cancellations === 1,
      "Stale Cancel must not invoke game cancellation"
    );
    assert(
      game.getPlayers().length === 2,
      "Stale Cancel must not reset players"
    );
    assert(
      game.settings.map === "DUELSTAL",
      "Stale Cancel must not reset settings"
    );
  } finally {
    (CurrentGameManager as any).cancelCurrentGame = originalCancel;
    game.reset();
  }
});

test("accidental game end cannot poison registration after a new announcement", async () => {
  const game = GameInstance.getInstance();
  game.reset();
  const { interaction: accidentalEnd } = await gameEndInteraction();
  await new GameCommand().execute(accidentalEnd);
  assert(
    !game.isFinished,
    "Accidental end must not mark an unannounced game finished"
  );

  game.isFinished = true;
  game.gameWinner = "BLUE";
  game.MVPPlayerBlue = "Stale MVP";
  game.blueMeanElo = 1500;
  game.startTime = new Date(Date.now() + 60 * 60 * 1000);
  game.settings.map = "DUELSTAL";
  game.beginConfirmedAnnouncement();
  assert(
    !game.gameWinner && !game.MVPPlayerBlue,
    "New announcement should clear stale results"
  );

  const config = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;
  const member = new FakeGuildMember("registration-player");
  guild.addMember(member);
  const teamCommand = new TeamCommand();
  const originalByDiscord = (prismaClient as any).player.byDiscordSnowflake;
  const originalFindFirst = (prismaClient as any).playerPunishment.findFirst;
  const originalFindMany = (prismaClient as any).playerPunishment.findMany;
  const originalUpdateMany = (prismaClient as any).playerPunishment.updateMany;
  const originalUsernameToUuid = MojangAPI.usernameToUUID;
  const originalAddPlayer = game.addPlayerByDiscordId;
  (prismaClient as any).player.byDiscordSnowflake = async () => null;
  (prismaClient as any).playerPunishment.findFirst = async () => null;
  (prismaClient as any).playerPunishment.findMany = async () => [];
  (prismaClient as any).playerPunishment.updateMany = async () => ({
    count: 0,
  });
  (MojangAPI as any).usernameToUUID = async () => "uuid-registration-player";
  (game as any).addPlayerByDiscordId = async (id: string, ign: string) => {
    const registered = player(id);
    registered.ignUsed = ign;
    game.teams.UNDECIDED.push(registered);
    return { error: false, playerInstance: registered };
  };

  try {
    const registerInteraction = createChatInputInteraction(member.id, {
      guild,
      channelId: config.channels.registration,
      strings: { ingamename: "FreshPlayer" },
    });
    await new RegisterCommand(teamCommand).execute(registerInteraction);
    assert(
      game.getPlayers().length === 1,
      "Registration should add the player"
    );

    const unregisterInteraction = createChatInputInteraction(member.id, {
      guild,
      channelId: config.channels.registration,
    });
    await new UnregisterCommand(teamCommand).execute(unregisterInteraction);
    assert(
      /successfully unregistered/i.test(replyText(unregisterInteraction)),
      "Unregister should succeed after announcement recovery"
    );
    assert(
      game.getPlayers().length === 0,
      "Unregister should remove the player"
    );
  } finally {
    (prismaClient as any).player.byDiscordSnowflake = originalByDiscord;
    (prismaClient as any).playerPunishment.findFirst = originalFindFirst;
    (prismaClient as any).playerPunishment.findMany = originalFindMany;
    (prismaClient as any).playerPunishment.updateMany = originalUpdateMany;
    (MojangAPI as any).usernameToUUID = originalUsernameToUuid;
    (game as any).addPlayerByDiscordId = originalAddPlayer;
    game.reset();
  }
});
