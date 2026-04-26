import { Team } from "@prisma/client";
import { duration, mean } from "./formatting";
import {
  SeasonRecapEloHistory,
  SeasonRecapGame,
  SeasonRecapModel,
  SeasonRecapThresholds,
} from "./types";

export function buildSeasonRecapModel(
  games: SeasonRecapGame[],
  histories: SeasonRecapEloHistory[],
  thresholds: SeasonRecapThresholds
): SeasonRecapModel {
  const historyByGamePlayer = new Map<string, SeasonRecapEloHistory>();
  for (const h of histories) {
    historyByGamePlayer.set(`${h.gameId}:${h.playerId}`, h);
  }

  const lastEloByPlayer = new Map<string, number>();
  const preEloByGamePlayer = new Map<string, number>();
  const outcomesByPlayer: SeasonRecapModel["outcomesByPlayer"] = new Map();
  const gameContexts: SeasonRecapModel["gameContexts"] = new Map();

  games.forEach((game, gameIndex) => {
    for (const gp of game.gameParticipations) {
      preEloByGamePlayer.set(
        `${game.id}:${gp.playerId}`,
        lastEloByPlayer.get(gp.playerId) ?? 1000
      );
    }

    const red = game.gameParticipations.filter((gp) => gp.team === Team.RED);
    const blue = game.gameParticipations.filter((gp) => gp.team === Team.BLUE);
    const redMean = mean(
      red.map(
        (gp) => preEloByGamePlayer.get(`${game.id}:${gp.playerId}`) ?? 1000
      )
    );
    const blueMean = mean(
      blue.map(
        (gp) => preEloByGamePlayer.get(`${game.id}:${gp.playerId}`) ?? 1000
      )
    );
    const eloGap = Math.abs(redMean - blueMean);
    const underdogTeam =
      redMean + thresholds.underdogEloGap <= blueMean
        ? Team.RED
        : blueMean + thresholds.underdogEloGap <= redMean
          ? Team.BLUE
          : null;
    const closeGame = eloGap < thresholds.closeGameEloGap;
    const durationMinutes = duration(game);

    gameContexts.set(game.id, {
      redMean,
      blueMean,
      eloGap,
      underdogTeam,
      closeGame,
      durationMinutes,
    });

    for (const gp of game.gameParticipations) {
      const post = historyByGamePlayer.get(`${game.id}:${gp.playerId}`);
      if (post) lastEloByPlayer.set(gp.playerId, post.elo);

      const outcomes = outcomesByPlayer.get(gp.playerId) ?? [];
      outcomes.push({
        playerId: gp.playerId,
        gameIndex,
        won: gp.team === game.winner,
        team: gp.team,
        map: game.settings?.map ?? "Unknown",
        durationMinutes,
        closeGame,
        underdog: underdogTeam === gp.team,
        captain: gp.captain,
        mvp: gp.mvp,
      });
      outcomesByPlayer.set(gp.playerId, outcomes);
    }
  });

  return { preEloByGamePlayer, gameContexts, outcomesByPlayer };
}
