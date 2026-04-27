import { Team } from "@prisma/client";
import { escapeIgn } from "../../util/Utils";
import { buildSeasonRecapModel } from "./model";
import { loadSeasonRecapData } from "./SeasonRecap";
import {
  DEFAULT_SEASON_RECAP_THRESHOLDS,
  PlayerGameOutcome,
  SeasonRecapData,
  SeasonRecapGame,
  SeasonRecapPlayer,
  SeasonRecapPlayerStats,
} from "./types";
import { formatDate, groupBy, pct, percentile, pretty } from "./formatting";

export type PersonalWrappedField = {
  name: string;
  value: string;
  inline?: boolean;
};

export type PersonalSeasonWrappedResult = {
  seasonNumber: number;
  playerName: string;
  title: string;
  description: string;
  fields: PersonalWrappedField[];
  footer: string;
  summary: {
    games: number;
    wins: number;
    losses: number;
    winRate: number;
    finalElo: number;
    rank: number;
    totalPlayers: number;
    percentile: number;
    seasonType: string;
  };
};

type WrappedCategory = "vibe" | "people" | "moment" | "special";

type InsightCard = {
  label: string;
  line: string;
  score: number;
  category: WrappedCategory;
};

type RelationshipRow = {
  playerId: string;
  games: number;
  wins: number;
};

type PairPathRow = {
  playerId: string;
  games: number;
  sameTeam: number;
  against: number;
};

type WrappedContext = {
  data: SeasonRecapData;
  games: SeasonRecapGame[];
  personalGames: SeasonRecapGame[];
  playerId: string;
  playerById: Map<string, SeasonRecapPlayer>;
  stats: SeasonRecapPlayerStats;
  outcomes: PlayerGameOutcome[];
  model: ReturnType<typeof buildSeasonRecapModel>;
};

export async function generatePersonalSeasonWrapped(options: {
  seasonNumber: number;
  playerId: string;
}): Promise<PersonalSeasonWrappedResult | null> {
  const data = await loadSeasonRecapData(options.seasonNumber);
  return generatePersonalSeasonWrappedFromData(data, options.playerId);
}

export function generatePersonalSeasonWrappedFromData(
  data: SeasonRecapData,
  playerId: string
): PersonalSeasonWrappedResult | null {
  const games = data.games
    .filter((game) => game.finished)
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const stats = data.playerStats.find((row) => row.playerId === playerId);
  if (!stats || totalGames(stats) === 0) return null;

  const playerById = collectPlayers(data, games);
  const model = buildSeasonRecapModel(
    games,
    data.histories,
    DEFAULT_SEASON_RECAP_THRESHOLDS
  );
  const outcomes = model.outcomesByPlayer.get(playerId) ?? [];
  if (!outcomes.length) return null;

  const personalGames = games.filter((game) =>
    game.gameParticipations.some((gp) => gp.playerId === playerId)
  );
  const context: WrappedContext = {
    data,
    games,
    personalGames,
    playerId,
    playerById,
    stats,
    outcomes,
    model,
  };
  const rank = calculateRank(data.playerStats, stats);
  const totalPlayers = data.playerStats.filter(
    (row) => totalGames(row) > 0
  ).length;
  const percentileValue =
    totalPlayers > 0 ? ((totalPlayers - rank) / totalPlayers) * 100 : 0;
  const selectedCards = selectCards(buildInsightCards(context));
  const fallbackCards = selectedCards.length
    ? selectedCards
    : buildFallbackCards(context);
  const seasonType = fallbackCards[0]?.label ?? "Season Regular";
  const playerName = displayName(playerId, playerById);

  return {
    seasonNumber: data.seasonNumber,
    playerName,
    title: `Season ${data.seasonNumber} Wrapped: ${playerName}`,
    description: `**${seasonType}**`,
    fields: buildFields(fallbackCards),
    footer: `Season ${data.seasonNumber} • ${outcomes.length} games played`,
    summary: {
      games: outcomes.length,
      wins: stats.wins,
      losses: stats.losses,
      winRate: winRate(stats),
      finalElo: stats.elo,
      rank,
      totalPlayers,
      percentile: percentileValue,
      seasonType,
    },
  };
}

function buildInsightCards(context: WrappedContext): InsightCard[] {
  return [
    ...buildRelationshipCards(context),
    ...buildMomentCards(context),
    ...buildDraftCards(context),
    ...buildMapCards(context),
    ...buildFormCards(context),
    ...buildRoleCards(context),
  ];
}

function buildFields(cards: InsightCard[]): PersonalWrappedField[] {
  const fields: PersonalWrappedField[] = [];
  const vibe = cards.find((card) => card.category === "vibe") ?? cards[0];
  if (vibe) {
    fields.push({
      name: "Season Vibe",
      value: `${vibe.label}\n${vibe.line}`,
    });
  }

  const grouped = groupCards(cards.filter((card) => card !== vibe));
  addField(fields, "People Lore", grouped.people);
  addField(fields, "Signature Moment", grouped.moment);
  addField(fields, "Special Mentions", grouped.special);

  return fields.length
    ? fields
    : [{ name: "Season Vibe", value: "Season Regular\nYou showed up." }];
}

function addField(
  fields: PersonalWrappedField[],
  name: string,
  cards: InsightCard[]
) {
  if (!cards.length) return;
  fields.push({
    name,
    value: cards.map((card) => `${card.label}\n${card.line}`).join("\n\n"),
  });
}

function buildRelationshipCards(context: WrappedContext): InsightCard[] {
  const teammates = new Map<string, RelationshipRow>();
  const opponents = new Map<string, RelationshipRow>();
  const paths = new Map<string, PairPathRow>();
  const trios = new Map<
    string,
    { players: [string, string, string]; games: number; wins: number }
  >();

  for (const game of context.games) {
    const playerGp = game.gameParticipations.find(
      (gp) => gp.playerId === context.playerId
    );
    if (!playerGp) continue;
    const won = playerGp.team === game.winner;

    for (const gp of game.gameParticipations) {
      if (gp.playerId === context.playerId) continue;
      const bucket = gp.team === playerGp.team ? teammates : opponents;
      const row = bucket.get(gp.playerId) ?? {
        playerId: gp.playerId,
        games: 0,
        wins: 0,
      };
      row.games += 1;
      if (won) row.wins += 1;
      bucket.set(gp.playerId, row);

      const path = paths.get(gp.playerId) ?? {
        playerId: gp.playerId,
        games: 0,
        sameTeam: 0,
        against: 0,
      };
      path.games += 1;
      if (gp.team === playerGp.team) path.sameTeam += 1;
      else path.against += 1;
      paths.set(gp.playerId, path);
    }

    const teamPlayers = game.gameParticipations
      .filter((gp) => gp.team === playerGp.team)
      .map((gp) => gp.playerId);
    for (let i = 0; i < teamPlayers.length; i += 1) {
      for (let j = i + 1; j < teamPlayers.length; j += 1) {
        if (
          teamPlayers[i] !== context.playerId &&
          teamPlayers[j] !== context.playerId
        ) {
          continue;
        }
        for (let k = j + 1; k < teamPlayers.length; k += 1) {
          const trio = [
            teamPlayers[i],
            teamPlayers[j],
            teamPlayers[k],
          ].sort() as [string, string, string];
          if (!trio.includes(context.playerId)) continue;
          const key = trio.join("::");
          const row = trios.get(key) ?? { players: trio, games: 0, wins: 0 };
          row.games += 1;
          if (won) row.wins += 1;
          trios.set(key, row);
        }
      }
    }
  }

  const cards: InsightCard[] = [];
  const bestTeammate = topRelationship(
    [...teammates.values()].filter((row) => row.games >= 2),
    "rate"
  );
  if (bestTeammate) {
    cards.push({
      label: "Best Duo",
      line: `You and ${displayName(bestTeammate.playerId, context.playerById)} were the pairing captains wanted: ${record(bestTeammate)} together.`,
      score: 96 + bestTeammate.games + bestTeammate.wins,
      category: "people",
    });
  }

  const roughTeammate = bottomRelationship(
    [...teammates.values()].filter(
      (row) => row.games > 0 && row.wins < row.games
    )
  );
  if (roughTeammate) {
    cards.push({
      label: "Cursed Duo",
      line: `${displayName(roughTeammate.playerId, context.playerById)} was your roughest teammate: ${record(roughTeammate)} together.`,
      score:
        101 + roughTeammate.games + (roughTeammate.games - roughTeammate.wins),
      category: "people",
    });
  }

  const bestOpponent = topRelationship(
    [...opponents.values()].filter((row) => row.games >= 2 && row.wins > 0),
    "rate"
  );
  if (bestOpponent) {
    cards.push({
      label: "Favourite Matchup",
      line: `${displayName(bestOpponent.playerId, context.playerById)} kept landing opposite you, and you took the edge: ${record(bestOpponent)}.`,
      score: 88 + bestOpponent.games + bestOpponent.wins,
      category: "people",
    });
  }

  const nemesis = bottomRelationship(
    [...opponents.values()].filter(
      (row) => row.games >= 2 && row.wins < row.games
    )
  );
  if (nemesis) {
    cards.push({
      label: "Nemesis",
      line: `${displayName(nemesis.playerId, context.playerById)} was the wall this season: ${record(nemesis)} against them.`,
      score: 92 + nemesis.games + (nemesis.games - nemesis.wins),
      category: "people",
    });
  }

  const neverTeamed = [...paths.values()]
    .filter((row) => row.games >= 3 && row.sameTeam === 0)
    .sort(
      (a, b) => b.games - a.games || a.playerId.localeCompare(b.playerId)
    )[0];
  if (neverTeamed) {
    cards.push({
      label: "Always Opposite",
      line: `You met ${displayName(neverTeamed.playerId, context.playerById)} ${neverTeamed.games} times and never shared a team.`,
      score: 80 + neverTeamed.games,
      category: "people",
    });
  }

  const bestTrio = [...trios.values()]
    .filter((row) => row.games >= 2)
    .sort(
      (a, b) =>
        b.wins / b.games - a.wins / a.games ||
        b.games - a.games ||
        a.players.join("").localeCompare(b.players.join(""))
    )[0];
  if (bestTrio) {
    const names = bestTrio.players
      .filter((id) => id !== context.playerId)
      .map((id) => displayName(id, context.playerById))
      .join(" + ");
    cards.push({
      label: "Three-Stack Energy",
      line: `Your best core was you + ${names}: ${record(bestTrio)}.`,
      score: 84 + bestTrio.games + bestTrio.wins,
      category: "people",
    });
  }

  return cards;
}

function buildMomentCards(context: WrappedContext): InsightCard[] {
  const cards: InsightCard[] = [];
  const rows = context.personalGames
    .map((game) => {
      const gp = game.gameParticipations.find(
        (row) => row.playerId === context.playerId
      );
      const gameContext = context.model.gameContexts.get(game.id);
      if (!gp || !gameContext) return null;
      return { game, gp, gameContext, won: gp.team === game.winner };
    })
    .filter(
      (
        row
      ): row is {
        game: SeasonRecapGame;
        gp: SeasonRecapGame["gameParticipations"][number];
        gameContext: NonNullable<
          ReturnType<typeof context.model.gameContexts.get>
        >;
        won: boolean;
      } => row !== null
    );

  const biggestUpset = [...rows]
    .filter((row) => row.won && row.gameContext.underdogTeam === row.gp.team)
    .sort((a, b) => b.gameContext.eloGap - a.gameContext.eloGap)[0];
  if (biggestUpset) {
    cards.push({
      label: "Upset Artist",
      line: `Your signature win was on ${pretty(biggestUpset.game.settings?.map ?? "Unknown")} (${formatDate(biggestUpset.game.startTime)}), beating a ${Math.round(biggestUpset.gameContext.eloGap)} average Elo gap.`,
      score: 98 + biggestUpset.gameContext.eloGap / 10,
      category: "moment",
    });
  }

  const mvpGame = rows.find((row) => row.gp.mvp);
  if (mvpGame) {
    cards.push({
      label: "MVP Spotlight",
      line: `You took MVP on ${pretty(mvpGame.game.settings?.map ?? "Unknown")} (${formatDate(mvpGame.game.startTime)}).`,
      score: 93,
      category: "moment",
    });
  }

  const closeWins = rows.filter(
    (row) => row.won && row.gameContext.closeGame
  ).length;
  if (closeWins > 0) {
    cards.push({
      label: "Clutch Closer",
      line: `You were on the winning side of ${closeWins} close game${plural(closeWins)}.`,
      score: 86 + closeWins * 3,
      category: "moment",
    });
  }

  const closeLosses = rows.filter(
    (row) => !row.won && row.gameContext.closeGame
  ).length;
  if (closeLosses > 0) {
    cards.push({
      label: "Heartbreak Games",
      line: `${closeLosses} loss${plural(closeLosses)} came in close games where the teams were nearly even.`,
      score: 74 + closeLosses * 2,
      category: "moment",
    });
  }

  const underdogWins = rows.filter(
    (row) => row.won && row.gameContext.underdogTeam === row.gp.team
  ).length;
  if (underdogWins > 0) {
    cards.push({
      label: "Underdog Run",
      line: `You helped flip ${underdogWins} underdog game${plural(underdogWins)}.`,
      score: 82 + underdogWins * 4,
      category: "moment",
    });
  }

  return cards;
}

function buildDraftCards(context: WrappedContext): InsightCard[] {
  const rows = context.personalGames
    .map((game) => {
      const drafted = game.gameParticipations.filter(
        (gp) => typeof gp.draftSlotPlacement === "number"
      );
      const gp = drafted.find((row) => row.playerId === context.playerId);
      if (!gp || typeof gp.draftSlotPlacement !== "number") return null;
      const slots = drafted.map((row) => row.draftSlotPlacement!);
      return {
        slot: gp.draftSlotPlacement,
        firstSlot: Math.min(...slots),
        lastSlot: Math.max(...slots),
        won: gp.team === game.winner,
      };
    })
    .filter(
      (
        row
      ): row is {
        slot: number;
        firstSlot: number;
        lastSlot: number;
        won: boolean;
      } => row !== null
    );
  if (!rows.length) return [];

  const cards: InsightCard[] = [];
  const averageSlot =
    rows.reduce((sum, row) => sum + row.slot, 0) / rows.length;
  const lateCutoff = percentile(
    context.games.flatMap((game) =>
      game.gameParticipations
        .map((gp) => gp.draftSlotPlacement)
        .filter((slot): slot is number => typeof slot === "number")
    ),
    DEFAULT_SEASON_RECAP_THRESHOLDS.lateDraftSlotPercentile
  );
  const lateRows = rows.filter((row) => row.slot >= lateCutoff);
  const firstPicks = rows.filter((row) => row.slot === row.firstSlot);
  const lastPicks = rows.filter((row) => row.slot === row.lastSlot);

  if (lateRows.length >= 2) {
    const lateWins = lateRows.filter((row) => row.won).length;
    cards.push({
      label: "Draft Steal",
      line: `You were picked late ${lateRows.length} times and still went ${lateWins}W-${lateRows.length - lateWins}L.`,
      score: 88 + lateRows.length + lateWins * 2,
      category: "special",
    });
  }
  if (firstPicks.length > 0) {
    const firstWins = firstPicks.filter((row) => row.won).length;
    cards.push({
      label: "First-Pick Pressure",
      line: `Captains grabbed you first ${firstPicks.length} time${plural(firstPicks.length)}; those teams went ${firstWins}W-${firstPicks.length - firstWins}L.`,
      score: 80 + firstPicks.length * 3,
      category: "special",
    });
  }
  if (lastPicks.length > 0) {
    const lastWins = lastPicks.filter((row) => row.won).length;
    cards.push({
      label: "Last-Pick Lore",
      line: `You were last off the board ${lastPicks.length} time${plural(lastPicks.length)} and turned that into ${lastWins} win${plural(lastWins)}.`,
      score: 78 + lastPicks.length * 2 + lastWins,
      category: "special",
    });
  }
  if (rows.length >= 3 && averageSlot >= lateCutoff) {
    cards.push({
      label: "Sleeper Pick",
      line: `Your average draft slot was ${averageSlot.toFixed(1)}, but your season still had teeth.`,
      score: 76 + rows.length,
      category: "special",
    });
  }

  return cards;
}

function buildMapCards(context: WrappedContext): InsightCard[] {
  const rows = [
    ...groupBy(context.outcomes, (outcome) => outcome.map).entries(),
  ]
    .map(([map, outcomes]) => ({
      map,
      games: outcomes.length,
      wins: outcomes.filter((outcome) => outcome.won).length,
    }))
    .filter((row) => row.games > 0);

  const cards: InsightCard[] = [];
  const best = [...rows]
    .filter((row) => row.games >= 2 && row.wins > 0)
    .sort(
      (a, b) =>
        b.wins / b.games - a.wins / a.games ||
        b.games - a.games ||
        a.map.localeCompare(b.map)
    )[0];
  if (best) {
    cards.push({
      label: "Map Specialist",
      line: `${pretty(best.map)} was your comfort map: ${best.wins}W-${best.games - best.wins}L.`,
      score: 84 + best.games + best.wins,
      category: "special",
    });
  }

  const cursed = [...rows]
    .filter((row) => row.games >= 2 && row.wins < row.games)
    .sort(
      (a, b) =>
        a.wins / a.games - b.wins / b.games ||
        b.games - a.games ||
        a.map.localeCompare(b.map)
    )[0];
  if (cursed) {
    cards.push({
      label: "Cursed Map",
      line: `${pretty(cursed.map)} did not treat you kindly: ${cursed.wins}W-${cursed.games - cursed.wins}L.`,
      score: 79 + cursed.games + (cursed.games - cursed.wins),
      category: "special",
    });
  }

  const modifiers = new Map<string, { games: number; wins: number }>();
  for (const game of context.personalGames) {
    const gp = game.gameParticipations.find(
      (row) => row.playerId === context.playerId
    );
    if (!gp) continue;
    for (const modifier of game.settings?.modifiers ?? []) {
      const label = `${modifier.category}: ${modifier.name}`;
      const row = modifiers.get(label) ?? { games: 0, wins: 0 };
      row.games += 1;
      if (gp.team === game.winner) row.wins += 1;
      modifiers.set(label, row);
    }
  }
  const modifier = [...modifiers.entries()]
    .filter(([, row]) => row.games >= 2)
    .sort(
      (a, b) =>
        b[1].games - a[1].games ||
        b[1].wins / b[1].games - a[1].wins / a[1].games ||
        a[0].localeCompare(b[0])
    )[0];
  if (modifier) {
    cards.push({
      label: "Modifier Magnet",
      line: `${modifier[0]} followed you around for ${modifier[1].games} games (${modifier[1].wins} wins).`,
      score: 72 + modifier[1].games,
      category: "special",
    });
  }

  return cards;
}

function buildFormCards(context: WrappedContext): InsightCard[] {
  const cards: InsightCard[] = [];
  const midpoint = Math.floor(context.outcomes.length / 2);
  const firstHalf = context.outcomes.slice(0, midpoint);
  const secondHalf = context.outcomes.slice(midpoint);
  if (firstHalf.length >= 2 && secondHalf.length >= 2) {
    const firstRate = winRateFromOutcomes(firstHalf);
    const secondRate = winRateFromOutcomes(secondHalf);
    if (secondRate > firstRate) {
      cards.push({
        label: "Second-Half Surge",
        line: `You improved from ${pct(firstRate)} to ${pct(secondRate)} after the midway point.`,
        score: 83 + (secondRate - firstRate) * 20,
        category: "vibe",
      });
    }
  }

  const finalRun = context.outcomes.slice(
    Math.floor(context.outcomes.length * 0.66)
  );
  if (finalRun.length >= 2) {
    const finalRate = winRateFromOutcomes(finalRun);
    if (finalRate >= 0.66) {
      cards.push({
        label: "Hot Finisher",
        line: `You closed the season at ${pct(finalRate)} over your final ${finalRun.length} games.`,
        score: 82 + finalRate * 10 + finalRun.length,
        category: "vibe",
      });
    }
  }

  const histories = context.data.histories
    .filter((history) => history.playerId === context.playerId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const elos = [1000, ...histories.map((history) => history.elo)];
  const lows = elos.filter(
    (elo) => elo < DEFAULT_SEASON_RECAP_THRESHOLDS.recoveryEloThreshold
  );
  const lowest = lows.length ? Math.min(...lows) : null;
  const final = elos.at(-1) ?? context.stats.elo;
  if (lowest !== null && final > lowest) {
    cards.push({
      label: "Elo Recovery Arc",
      line: `You climbed back from ${lowest} to ${final} after dipping below ${DEFAULT_SEASON_RECAP_THRESHOLDS.recoveryEloThreshold}.`,
      score: 81 + (final - lowest) / 10,
      category: "vibe",
    });
  }

  if (context.stats.biggestWinStreak >= 3) {
    cards.push({
      label: "Streak Mode",
      line: `Your longest heater was ${context.stats.biggestWinStreak} wins in a row.`,
      score: 70 + context.stats.biggestWinStreak * 2,
      category: "vibe",
    });
  }

  return cards;
}

function buildRoleCards(context: WrappedContext): InsightCard[] {
  const cards: InsightCard[] = [];
  const mvpCount = context.outcomes.filter((outcome) => outcome.mvp).length;
  if (mvpCount > 0) {
    cards.push({
      label: "MVP Magnet",
      line: `You took MVP ${mvpCount} time${plural(mvpCount)}.`,
      score: 94 + mvpCount * 4,
      category: "vibe",
    });
  }

  const captainGames = context.outcomes.filter((outcome) => outcome.captain);
  if (captainGames.length > 0) {
    const captainWins = captainGames.filter((outcome) => outcome.won).length;
    cards.push({
      label: "Captain Chapter",
      line: `You captained ${captainGames.length} time${plural(captainGames.length)} and went ${captainWins}W-${captainGames.length - captainWins}L.`,
      score: 78 + captainGames.length * 2 + captainWins,
      category: "special",
    });
    const captainUpsets = captainGames.filter(
      (outcome) => outcome.underdog && outcome.won
    ).length;
    if (captainUpsets > 0) {
      cards.push({
        label: "Upset Captain",
        line: `${captainUpsets} of your captain wins came as the underdog.`,
        score: 87 + captainUpsets * 4,
        category: "moment",
      });
    }
  }

  const votes = context.personalGames.filter((game) =>
    game.gameParticipations.some(
      (gp) => gp.playerId === context.playerId && gp.votedForAMVP
    )
  ).length;
  if (votes >= 2) {
    cards.push({
      label: "Ballot Regular",
      line: `You voted for MVP in ${votes} of your ${context.outcomes.length} games.`,
      score: 62 + votes,
      category: "special",
    });
  }

  return cards;
}

function selectCards(cards: InsightCard[]) {
  const selected: InsightCard[] = [];
  const categoryCounts = new Map<WrappedCategory, number>();
  const sorted = [...cards].sort(
    (a, b) =>
      b.score - a.score ||
      categoryPriority(a.category) - categoryPriority(b.category) ||
      a.label.localeCompare(b.label) ||
      a.line.localeCompare(b.line)
  );

  for (const card of sorted) {
    const count = categoryCounts.get(card.category) ?? 0;
    if (count >= categoryLimit(card.category)) continue;
    selected.push(card);
    categoryCounts.set(card.category, count + 1);
    if (selected.length >= 7) break;
  }

  return selected;
}

function categoryLimit(category: WrappedCategory) {
  return category === "people" ? 3 : 2;
}

function buildFallbackCards(context: WrappedContext): InsightCard[] {
  const map = [
    ...groupBy(context.outcomes, (outcome) => outcome.map).entries(),
  ].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  const frequentTeammate = topRelationship(
    [...buildBasicTeammates(context).values()],
    "games"
  );
  const cards: InsightCard[] = [
    {
      label: "Season Regular",
      line: `You played ${context.outcomes.length} game${plural(context.outcomes.length)} this season.`,
      score: 1,
      category: "vibe",
    },
  ];
  if (map) {
    cards.push({
      label: "Most Visited Map",
      line: `${pretty(map[0])} showed up most often for you.`,
      score: 1,
      category: "special",
    });
  }
  if (frequentTeammate) {
    cards.push({
      label: "Most Familiar Teammate",
      line: `${displayName(frequentTeammate.playerId, context.playerById)} teamed with you most often.`,
      score: 1,
      category: "people",
    });
  }
  return cards;
}

function groupCards(cards: InsightCard[]) {
  return {
    people: cards.filter((card) => card.category === "people"),
    moment: cards.filter((card) => card.category === "moment"),
    special: cards.filter(
      (card) => card.category === "special" || card.category === "vibe"
    ),
  };
}

function buildBasicTeammates(context: WrappedContext) {
  const teammates = new Map<string, RelationshipRow>();
  for (const game of context.personalGames) {
    const playerGp = game.gameParticipations.find(
      (gp) => gp.playerId === context.playerId
    );
    if (!playerGp) continue;
    for (const gp of game.gameParticipations) {
      if (gp.playerId === context.playerId || gp.team !== playerGp.team) {
        continue;
      }
      const row = teammates.get(gp.playerId) ?? {
        playerId: gp.playerId,
        games: 0,
        wins: 0,
      };
      row.games += 1;
      if (playerGp.team === game.winner) row.wins += 1;
      teammates.set(gp.playerId, row);
    }
  }
  return teammates;
}

function collectPlayers(data: SeasonRecapData, games: SeasonRecapGame[]) {
  const playerById = new Map<string, SeasonRecapPlayer>();
  for (const stats of data.playerStats) {
    if (stats.player) playerById.set(stats.playerId, stats.player);
  }
  for (const game of games) {
    for (const gp of game.gameParticipations) {
      if (gp.player) playerById.set(gp.playerId, gp.player);
    }
  }
  return playerById;
}

function calculateRank(
  playerStats: SeasonRecapPlayerStats[],
  stats: SeasonRecapPlayerStats
) {
  return (
    playerStats.filter((row) => totalGames(row) > 0 && row.elo > stats.elo)
      .length + 1
  );
}

function topRelationship(rows: RelationshipRow[], mode: "games" | "rate") {
  if (!rows.length) return null;
  return [...rows].sort((a, b) => {
    if (mode === "rate") {
      return (
        b.wins / b.games - a.wins / a.games ||
        b.wins - a.wins ||
        b.games - a.games ||
        a.playerId.localeCompare(b.playerId)
      );
    }
    return (
      b.games - a.games ||
      b.wins - a.wins ||
      a.playerId.localeCompare(b.playerId)
    );
  })[0];
}

function bottomRelationship(rows: RelationshipRow[]) {
  if (!rows.length) return null;
  return [...rows].sort(
    (a, b) =>
      a.wins / a.games - b.wins / b.games ||
      b.games - a.games ||
      a.wins - b.wins ||
      a.playerId.localeCompare(b.playerId)
  )[0];
}

function categoryPriority(category: WrappedCategory) {
  const priorities: Record<WrappedCategory, number> = {
    vibe: 0,
    people: 1,
    moment: 2,
    special: 3,
  };
  return priorities[category];
}

function displayName(
  playerId: string,
  players: Map<string, SeasonRecapPlayer>
) {
  void playerId;
  return escapeIgn(players.get(playerId)?.latestIGN ?? "Unknown Player");
}

function record(row: { games: number; wins: number }) {
  return `${row.wins}W-${row.games - row.wins}L`;
}

function totalGames(stats: SeasonRecapPlayerStats) {
  return stats.wins + stats.losses;
}

function winRate(stats: SeasonRecapPlayerStats) {
  const games = totalGames(stats);
  return games ? stats.wins / games : 0;
}

function winRateFromOutcomes(outcomes: PlayerGameOutcome[]) {
  return outcomes.length
    ? outcomes.filter((outcome) => outcome.won).length / outcomes.length
    : 0;
}

function plural(count: number) {
  return count === 1 ? "" : "s";
}
