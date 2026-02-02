import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { EloUtil } from "../../src/util/EloUtil";

test("Win streak bonus should apply when a player reaches 3 on this win", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();

  // Simulate pre-game streak=2 and post-game streak=3 (after the win is applied).
  const player = {
    discordSnowflake: "R1",
    ignUsed: "Streaker",
    elo: 1200,
    winStreak: 2,
  } as any;
  const opponent = {
    discordSnowflake: "B1",
    ignUsed: "Opponent",
    elo: 1200,
    winStreak: 0,
  } as any;

  (game as any).teams = { RED: [player], BLUE: [opponent], UNDECIDED: [] };
  game.calculateMeanEloAndExpectedScore();

  const noBonus = EloUtil.calculateEloChange(game, player, true);
  assert(noBonus > 0, "sanity: win should grant positive Elo");

  // Apply the win result to the in-memory stats (this is what saveGameFromInstance
  // now does before applying Elo).
  player.winStreak += 1; // becomes 3

  const withBonus = EloUtil.calculateEloChange(game, player, true);
  assert(
    withBonus > noBonus,
    `expected bonus on streak 3 (${withBonus}) > (${noBonus})`
  );
});
