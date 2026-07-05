import GameCommand from "../../src/commands/GameCommand";
import { prismaClient } from "../../src/database/prismaClient";
import { assert } from "../framework/assert";
import { createChatInputInteraction } from "../framework/mocks";
import { test } from "../framework/test";

function replyContent(interaction: { replies: any[] }): string {
  const reply = interaction.replies.find((r: any) => r.type === "reply");
  const payload = reply?.payload;
  return typeof payload === "string" ? payload : String(payload?.content ?? "");
}

test("/game request fills template with stored leader ign and defaults", async () => {
  const originalByDiscord = (prismaClient as any).player.byDiscordSnowflake;
  (prismaClient as any).player.byDiscordSnowflake = async () => ({
    latestIGN: "Notch",
  });

  try {
    const cmd = new GameCommand();
    const interaction = createChatInputInteraction("U1", {
      subcommand: "request",
      strings: {
        time: "1783774800",
        banned_classes: "SWA",
        map: "Nature",
      },
    });

    await cmd.execute(interaction);
    const content = replyContent(interaction);

    assert(
      content.includes(":alarm_clock: Time: <t:1783774800:F>"),
      "uses unix timestamp"
    );
    assert(
      content.includes(":name_badge: Leader IGN: Notch"),
      "fills stored latestIGN"
    );
    assert(content.includes(":x: Banned Classes: SWA"), "includes bans");
    assert(content.includes(":map: Map: Nature"), "includes map");
    assert(
      content.includes(":five: Phase 5 Type: Nothing"),
      "defaults phase 5 type"
    );
    assert(content.includes(":people_wrestling: Duel: Yes"), "defaults duel");
    assert(
      content.includes(":eye: Looking for players: No"),
      "defaults looking for players"
    );
  } finally {
    (prismaClient as any).player.byDiscordSnowflake = originalByDiscord;
  }
});

test("/game request leaves leader ign blank when no latestIGN exists", async () => {
  const originalByDiscord = (prismaClient as any).player.byDiscordSnowflake;
  (prismaClient as any).player.byDiscordSnowflake = async () => null;

  try {
    const cmd = new GameCommand();
    const interaction = createChatInputInteraction("U1", {
      subcommand: "request",
      strings: {
        time: "1783774800",
        banned_classes: "none",
        map: "Custom Map",
        phase_5_type: "Bleed",
        duel: "No",
        looking_for_players: "Yes",
      },
    });

    await cmd.execute(interaction);
    const content = replyContent(interaction);

    assert(
      content.includes(":name_badge: Leader IGN: "),
      "keeps leader ign field present"
    );
    assert(
      !content.includes(":name_badge: Leader IGN: user-U1"),
      "does not fallback to discord username"
    );
    assert(
      content.includes(":five: Phase 5 Type: Bleed"),
      "uses provided phase 5 type"
    );
    assert(content.includes(":people_wrestling: Duel: No"), "uses duel value");
    assert(
      content.includes(":eye: Looking for players: Yes"),
      "uses looking for players value"
    );
  } finally {
    (prismaClient as any).player.byDiscordSnowflake = originalByDiscord;
  }
});

test("/game request accepts natural language time", async () => {
  const originalByDiscord = (prismaClient as any).player.byDiscordSnowflake;
  (prismaClient as any).player.byDiscordSnowflake = async () => ({
    latestIGN: "Notch",
  });

  try {
    const cmd = new GameCommand();
    const interaction = createChatInputInteraction("U1", {
      subcommand: "request",
      strings: {
        time: "2025-01-01 19:00",
        timezone: "GMT",
        banned_classes: "SWA",
        map: "Nature",
      },
    });

    await cmd.execute(interaction);
    const content = replyContent(interaction);

    assert(
      /:alarm_clock: Time: <t:\d+:F>/.test(content),
      "natural language time becomes a discord timestamp"
    );
  } finally {
    (prismaClient as any).player.byDiscordSnowflake = originalByDiscord;
  }
});
