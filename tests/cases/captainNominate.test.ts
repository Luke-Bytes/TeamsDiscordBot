import CaptainNominateCommand from "../../src/commands/CaptainNominate";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { ConfigManager } from "../../src/ConfigManager";
import { assert } from "../framework/assert";
import {
  FakeGuild,
  FakeGuildMember,
  createButtonInteraction,
  createChatInputInteraction,
} from "../framework/mocks";
import { test } from "../framework/test";

type SentMessage = { content: string; components?: any[] };

test("Captain nomination end-to-end flow", async () => {
  console.log("-- Captain Nominate Flow Test --");

  // Prepare config role IDs
  const config = ConfigManager.getConfig();
  const organiserRole = config.roles.organiserRole || "organiser";
  const captainRole = config.roles.captainRole || "captain";
  const redRole = config.roles.redTeamRole || "red";
  const blueRole = config.roles.blueTeamRole || "blue";

  // Capture gameFeed messages
  const sent: SentMessage[] = [];
  const originalSend = DiscordUtil.sendMessage;
  (DiscordUtil as any).sendMessage = async (_channel: any, content: any) => {
    if (typeof content === "string") {
      sent.push({ content });
    } else {
      sent.push({ content: content.content, components: content.components });
    }
  };

  try {
    // Setup game state
    const game = CurrentGameManager.getCurrentGame();
    game.reset();
    game.announced = true;

    const playerA = {
      discordSnowflake: "1001",
      ignUsed: "Alice",
      captain: false,
    } as any;
    const playerB = {
      discordSnowflake: "1002",
      ignUsed: "Bob",
      captain: false,
    } as any;
    const playerC = {
      discordSnowflake: "1003",
      ignUsed: "Cara",
      captain: false,
    } as any;
    // Place A in RED, B in BLUE, C undecided
    (game as any).teams = {
      RED: [playerA],
      BLUE: [playerB],
      UNDECIDED: [playerC],
    };

    // Simulate nomination by Cara (1003)
    const command = new CaptainNominateCommand();
    const nominateInteraction = createChatInputInteraction("1003");
    await command.execute(nominateInteraction);

    assert(sent.length >= 1, "Nomination should send a gameFeed message");
    const last = sent[sent.length - 1];
    assert(
      last.components && last.components.length > 0,
      "GameFeed message should include Set Captain button"
    );
    assert(
      /<@1003>/.test(last.content),
      "Nomination message should mention the nominator"
    );

    // Prepare guild with organiser who will click
    const guild = new FakeGuild();
    const organiser = new FakeGuildMember("2000");
    await organiser.roles.add(organiserRole);
    const nominatedMember = new FakeGuildMember("1003");
    guild.addMember(organiser);
    guild.addMember(nominatedMember);

    // Click Set Captain as organiser
    const button = createButtonInteraction(
      "captainnominate-set",
      last.content,
      "2000",
      guild as any
    );
    await (command as any).handleButtonPress(button);

    // Verify captain set for the team without a captain (prefer player's team if applicable)
    // RED has no captain, BLUE has no captain -> playerC is UNDECIDED, so first missing should be RED per logic
    const redCaptain = game.getCaptainOfTeam("RED");
    const blueCaptain = game.getCaptainOfTeam("BLUE");
    assert(
      redCaptain?.discordSnowflake === "1003" ||
        blueCaptain?.discordSnowflake === "1003",
      "Cara should become a captain of a team"
    );

    // Verify roles updated on nominated member
    const nominatedRoles = nominatedMember.roles.cache.toArray();
    assert(
      nominatedRoles.includes(captainRole),
      "Nominated member should receive captain role"
    );
    if (redCaptain?.discordSnowflake === "1003") {
      assert(
        nominatedRoles.includes(redRole),
        "Captain should have red role if RED captain"
      );
      assert(
        !nominatedRoles.includes(blueRole),
        "Captain should not have blue role if RED captain"
      );
    } else if (blueCaptain?.discordSnowflake === "1003") {
      assert(
        nominatedRoles.includes(blueRole),
        "Captain should have blue role if BLUE captain"
      );
      assert(
        !nominatedRoles.includes(redRole),
        "Captain should not have red role if BLUE captain"
      );
    }

    // Ensure a confirmation feed message was sent
    const confirmation = sent.find((m) => /captain/i.test(m.content));
    assert(!!confirmation, "Should announce captain setting to gameFeed");
  } finally {
    // Restore patched util
    (DiscordUtil as any).sendMessage = originalSend;
  }
});
