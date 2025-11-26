import { test } from "../framework/test";
import { assert } from "../framework/assert";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import PlayerCommand from "../../src/commands/PlayerCommand";
import TeamCommand from "../../src/commands/TeamCommand";
import CaptainCommand from "../../src/commands/CaptainCommand";
import { prismaClient } from "../../src/database/prismaClient";
import { ConfigManager } from "../../src/ConfigManager";

// Utility to register simple in-memory players and wire prisma lookups
function setupPlayers(guild: FakeGuild, names: string[]): void {
  const idToPlayer = new Map<string, any>();
  names.forEach((name, i) => {
    const snowflake = `U${i + 1}`;
    const rec = {
      id: `db-${snowflake}`,
      discordSnowflake: snowflake,
      latestIGN: name,
    };
    idToPlayer.set(snowflake, rec);
    guild.addMember(new FakeGuildMember(snowflake) as any);
  });
  (prismaClient as any).player.findFirst = async ({ where }: any) => {
    const ident =
      where?.OR?.[0]?.discordSnowflake || where?.OR?.[1]?.latestIGN?.equals;
    for (const p of Array.from(idToPlayer.values())) {
      if (
        p.discordSnowflake === ident ||
        p.latestIGN?.toLowerCase() === String(ident).toLowerCase()
      )
        return p;
    }
    return null;
  };
  (prismaClient as any).player.byDiscordSnowflake = async (id: string) =>
    idToPlayer.get(id) || null;
}

test("/player add, move, remove, replace update teams correctly", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  const guild = new FakeGuild() as any;
  const cfg = ConfigManager.getConfig();
  const organiser = new FakeGuildMember("ORG") as any;
  await organiser.roles.add(cfg.roles.organiserRole);
  guild.addMember(organiser);

  setupPlayers(guild, ["Alice", "Bob", "Cara"]);
  // Pretend players are registered in UNDECIDED
  (game as any).teams = {
    RED: [],
    BLUE: [],
    UNDECIDED: [
      { discordSnowflake: "U1", ignUsed: "Alice" },
      { discordSnowflake: "U2", ignUsed: "Bob" },
      { discordSnowflake: "U3", ignUsed: "Cara" },
    ],
  };

  const cmd = new PlayerCommand();

  // add Alice to BLUE
  const addAlice = createChatInputInteraction("ORG", {
    guild,
    member: organiser,
    subcommand: "add",
    strings: { player: "Alice", team: "BLUE" },
  });
  await cmd.execute(addAlice);
  assert(
    game.getPlayersOfTeam("BLUE").some((p) => p.ignUsed === "Alice"),
    "Alice added to BLUE"
  );

  // move Alice BLUE -> RED
  const moveAlice = createChatInputInteraction("ORG", {
    guild,
    member: organiser,
    subcommand: "move",
    strings: { player: "Alice", from: "BLUE", to: "RED" },
  });
  await cmd.execute(moveAlice);
  assert(
    game.getPlayersOfTeam("RED").some((p) => p.ignUsed === "Alice"),
    "Alice moved to RED"
  );

  // replace Alice with Bob on RED
  const replace = createChatInputInteraction("ORG", {
    guild,
    member: organiser,
    subcommand: "replace",
    strings: { old_player: "Alice", new_player: "Bob" },
  });
  await cmd.execute(replace);
  assert(
    !game.getPlayersOfTeam("RED").some((p) => p.ignUsed === "Alice"),
    "Alice removed from RED"
  );
  assert(
    game.getPlayersOfTeam("RED").some((p) => p.ignUsed === "Bob"),
    "Bob added to RED"
  );

  // remove Bob
  const removeBob = createChatInputInteraction("ORG", {
    guild,
    member: organiser,
    subcommand: "remove",
    strings: { player: "Bob" },
  });
  await cmd.execute(removeBob);
  assert(
    !game.getPlayersOfTeam("RED").some((p) => p.ignUsed === "Bob"),
    "Bob removed from game"
  );
});

test("/captain set honors team-decided rules and team membership tracking", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  const guild = new FakeGuild() as any;
  const cfg = ConfigManager.getConfig();
  const organiser = new FakeGuildMember("ORG2") as any;
  await organiser.roles.add(cfg.roles.organiserRole);
  guild.addMember(organiser);

  // Setup two players on RED and one on UNDECIDED
  const pRedOld = {
    discordSnowflake: "R-OLD",
    ignUsed: "RedOld",
    elo: 1100,
    captain: true,
  } as any;
  const pRedNew = {
    discordSnowflake: "R-NEW",
    ignUsed: "RedNew",
    elo: 1110,
  } as any;
  const pUnd = {
    discordSnowflake: "U-X",
    ignUsed: "UndecidedX",
    elo: 1000,
  } as any;
  (game as any).teams = {
    RED: [pRedOld],
    BLUE: [],
    UNDECIDED: [pRedNew, pUnd],
  };
  (prismaClient as any).player.findFirst = async ({ where }: any) => {
    const ign = where?.OR?.[1]?.latestIGN?.equals;
    if (/rednew/i.test(ign))
      return { latestIGN: "RedNew", discordSnowflake: "R-NEW" };
    if (/redold/i.test(ign))
      return { latestIGN: "RedOld", discordSnowflake: "R-OLD" };
    return null;
  };
  const teamCmd = new TeamCommand();
  const capCmd = new CaptainCommand(teamCmd);

  // Case 1: Teams NOT decided -> old captain moved to UNDECIDED
  (game as any).teamsDecidedBy = null;
  const setCap1 = createChatInputInteraction("ORG2", {
    guild,
    member: organiser,
    subcommand: "set",
    strings: { user: "RedNew", team: "red" },
  });
  await capCmd.execute(setCap1);
  assert(
    game.getCaptainOfTeam("RED")?.discordSnowflake === "R-NEW",
    "New red captain set"
  );
  assert(
    game
      .getPlayersOfTeam("UNDECIDED")
      .some((p) => p.discordSnowflake === "R-OLD"),
    "Old captain moved to UNDECIDED"
  );

  // Prepare Case 2: Teams decided -> old captain stays on team
  // Put old back to RED and mark teams decided
  (game as any).teams = {
    RED: [pRedOld, pRedNew],
    BLUE: [],
    UNDECIDED: [pUnd],
  };
  pRedOld.captain = true;
  pRedNew.captain = false;
  (game as any).teamsDecidedBy = "RANDOMISED";

  const setCap2 = createChatInputInteraction("ORG2", {
    guild,
    member: organiser,
    subcommand: "set",
    strings: { user: "RedNew", team: "red" },
  });
  await capCmd.execute(setCap2);
  assert(
    game.getCaptainOfTeam("RED")?.discordSnowflake === "R-NEW",
    "New red captain set when decided"
  );
  assert(
    game
      .getPlayersOfTeam("UNDECIDED")
      .some((p) => p.discordSnowflake === "R-OLD"),
    "Old captain should move to UNDECIDED even when teams decided"
  );
});

test("/team generate method:draft requires even number of UNDECIDED players", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  (game as any).announced = true;
  const guild = new FakeGuild() as any;
  const cfg = ConfigManager.getConfig();
  const organiser = new FakeGuildMember("ORG3") as any;
  await organiser.roles.add(cfg.roles.organiserRole);
  guild.addMember(organiser);

  // Setup two captains (so the check proceeds) and 3 undecided players (odd)
  const redCap = {
    discordSnowflake: "RC1",
    ignUsed: "RedCap",
    captain: true,
  } as any;
  const blueCap = {
    discordSnowflake: "BC1",
    ignUsed: "BlueCap",
    captain: true,
  } as any;
  const u1 = { discordSnowflake: "U1", ignUsed: "U1" } as any;
  const u2 = { discordSnowflake: "U2", ignUsed: "U2" } as any;
  const u3 = { discordSnowflake: "U3", ignUsed: "U3" } as any;
  (game as any).teams = {
    RED: [redCap],
    BLUE: [blueCap],
    UNDECIDED: [u1, u2, u3],
  };

  const teamCmd = new TeamCommand();
  const interaction = createChatInputInteraction("ORG3", {
    guild,
    member: organiser,
    subcommand: "generate",
    strings: { method: "draft" },
  });
  await teamCmd.execute(interaction);

  const reply = interaction.replies.find((r) => r.type === "reply");
  assert(
    !!reply &&
      /even number of registered players/.test(String(reply.payload?.content)),
    "Should inform about even number requirement and not start draft"
  );
  assert(
    !teamCmd.teamPickingSession,
    "Draft session should not start on odd count"
  );
});

test("CaptainCommand randomise picks captains and moves old to UNDECIDED", async () => {
  const config = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;
  const organiser = new FakeGuildMember("ORG3");
  await organiser.roles.cache.add(config.roles.organiserRole);
  guild.addMember(organiser);

  const oldCaptain = {
    discordSnowflake: "OLD",
    ignUsed: "OldCap",
    elo: 1200,
    captain: true,
  } as any;
  const p1 = { discordSnowflake: "P1", ignUsed: "Alpha", elo: 1100 } as any;
  const p2 = { discordSnowflake: "P2", ignUsed: "Beta", elo: 1300 } as any;

  const game = CurrentGameManager.getCurrentGame();
  game.reset();
  (game as any).teams = {
    RED: [oldCaptain],
    BLUE: [],
    UNDECIDED: [p1, p2],
  };

  const mOld = guild.addMember(new FakeGuildMember("OLD"));
  const m1 = guild.addMember(new FakeGuildMember("P1"));
  const m2 = guild.addMember(new FakeGuildMember("P2"));
  (mOld as any).presence = { status: "offline" };
  (m1 as any).presence = { status: "online" };
  (m2 as any).presence = { status: "dnd" };

  const teamCmd = new TeamCommand();
  const capCmd = new CaptainCommand(teamCmd);

  const origRand = Math.random;
  Math.random = () => 0; // pick P1 first, then P2 as nearest higher

  const interaction = createChatInputInteraction("ORG3", {
    guild,
    member: organiser,
    subcommand: "randomise",
  });

  try {
    await capCmd.execute(interaction as any);
    const redCap = game.getCaptainOfTeam("RED");
    const blueCap = game.getCaptainOfTeam("BLUE");
    const capIds = [redCap?.discordSnowflake, blueCap?.discordSnowflake];
    assert(
      capIds.includes("P1") && capIds.includes("P2"),
      "P1 and P2 should be set as captains"
    );
    assert(
      game
        .getPlayersOfTeam("UNDECIDED")
        .some((p) => p.discordSnowflake === "OLD"),
      "Old captain should move to UNDECIDED after reassignment"
    );
  } finally {
    Math.random = origRand;
  }
});
