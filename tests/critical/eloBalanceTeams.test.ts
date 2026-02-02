import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { GameInstance } from "../../src/database/GameInstance";

function mkPlayer(id: string, elo: number) {
  return { discordSnowflake: id, ignUsed: id, elo } as any;
}

test("Elo team generation alternates by rank and sets top captains", async () => {
  const game = GameInstance.getInstance();
  game.reset();

  const players = [
    mkPlayer("P1", 1500),
    mkPlayer("P2", 1400),
    mkPlayer("P3", 1300),
    mkPlayer("P4", 1200),
    mkPlayer("P5", 1100),
    mkPlayer("P6", 1000),
  ];
  (game as any).teams = { RED: [], BLUE: [], UNDECIDED: players };

  game.createTeams("elo");

  const blueIds = game
    .getPlayersOfTeam("BLUE")
    .map((p: any) => p.discordSnowflake);
  const redIds = game
    .getPlayersOfTeam("RED")
    .map((p: any) => p.discordSnowflake);

  assertEqual(
    blueIds.join(","),
    "P1,P3,P5",
    "Blue should get 1st, 3rd, 5th by Elo"
  );
  assertEqual(
    redIds.join(","),
    "P2,P4,P6",
    "Red should get 2nd, 4th, 6th by Elo"
  );

  assert(
    game.getCaptainOfTeam("BLUE")?.discordSnowflake === "P1",
    "Top Elo on Blue should be captain"
  );
  assert(
    game.getCaptainOfTeam("RED")?.discordSnowflake === "P2",
    "Top Elo on Red should be captain"
  );
});

test("Balance team generation picks closest-Elo captains after random first pick", async () => {
  const game = GameInstance.getInstance();
  game.reset();

  const players = [
    mkPlayer("P1", 2000),
    mkPlayer("P2", 1950),
    mkPlayer("P3", 1500),
    mkPlayer("P4", 1100),
  ];
  (game as any).teams = { RED: [], BLUE: [], UNDECIDED: players };

  const origRandom = Math.random;
  Math.random = () => 0; // pick P1 first
  try {
    game.createTeams("balance");
  } finally {
    Math.random = origRandom;
  }

  const blueCaptain = game.getCaptainOfTeam("BLUE");
  const redCaptain = game.getCaptainOfTeam("RED");
  const captainIds = [
    blueCaptain?.discordSnowflake,
    redCaptain?.discordSnowflake,
  ];

  assert(captainIds.includes("P1"), "First random captain should be P1");
  assert(captainIds.includes("P2"), "Closest Elo captain should be P2");
});

test("Balance team generation keeps team sizes even", async () => {
  const game = GameInstance.getInstance();
  game.reset();

  const players = [
    mkPlayer("P1", 1600),
    mkPlayer("P2", 1550),
    mkPlayer("P3", 1500),
    mkPlayer("P4", 1450),
    mkPlayer("P5", 1400),
    mkPlayer("P6", 1350),
    mkPlayer("P7", 1300),
    mkPlayer("P8", 1250),
  ];
  (game as any).teams = { RED: [], BLUE: [], UNDECIDED: players };

  const origRandom = Math.random;
  Math.random = () => 0.3;
  try {
    game.createTeams("balance");
  } finally {
    Math.random = origRandom;
  }

  assertEqual(
    game.getPlayersOfTeam("BLUE").length,
    game.getPlayersOfTeam("RED").length,
    "Balanced teams should be even sizes"
  );
});
