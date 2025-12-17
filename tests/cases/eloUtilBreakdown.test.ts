import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { CurrentGameManager } from "../../src/logic/CurrentGameManager";
import { EloUtil } from "../../src/util/EloUtil";

test("Elo change can be higher for higher-elo teammate due to win streak bonus", async () => {
  const game = CurrentGameManager.getCurrentGame();
  game.reset();

  const redHighEloHighStreak = {
    discordSnowflake: "R1",
    ignUsed: "HighEloHighStreak",
    elo: 1290,
    winStreak: 4,
  } as any;

  const redLowerEloNoStreak = {
    discordSnowflake: "R2",
    ignUsed: "LowerEloNoStreak",
    elo: 1200,
    winStreak: 0,
  } as any;

  const blueOpponent = {
    discordSnowflake: "B1",
    ignUsed: "BlueOpponent",
    elo: 1500,
    winStreak: 0,
  } as any;

  (game as any).teams = {
    RED: [redHighEloHighStreak, redLowerEloNoStreak],
    BLUE: [blueOpponent],
    UNDECIDED: [],
  };
  game.calculateMeanEloAndExpectedScore();

  const high = EloUtil.calculateEloChange(game, redHighEloHighStreak, true);
  const low = EloUtil.calculateEloChange(game, redLowerEloNoStreak, true);

  assert(high > low, `expected ${high} > ${low}`);

  const breakdown = EloUtil.getEloChangeBreakdown(
    game,
    redHighEloHighStreak,
    true
  );
  assert(
    breakdown.finalChange === high,
    `expected breakdown.finalChange (${breakdown.finalChange}) === calculateEloChange (${high})`
  );
});
