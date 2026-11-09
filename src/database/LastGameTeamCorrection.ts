import { createHash } from "node:crypto";
import { PlayerStats, Prisma, Team } from "@prisma/client";
import { ConfigManager } from "../ConfigManager";
import { EloUtil, EloGameContext } from "../util/EloUtil";
import type { PlayerInstance } from "./PlayerInstance";

export type TeamMove = { identifier: string; team: Team };
export type CorrectionOptions = {
  seasonNumber?: number;
  removePlayers?: string[];
  // Legacy games did not store this flag. Never silently assume its value.
  legacyDoubleElo?: boolean;
};

const gameInclude = {
  gameParticipations: {
    include: { player: true },
    orderBy: { id: "asc" as const },
  },
  eloHistories: { orderBy: { id: "asc" as const } },
};

const statKeys = [
  "elo",
  "wins",
  "losses",
  "winStreak",
  "loseStreak",
  "biggestWinStreak",
  "biggestLosingStreak",
] as const;
type ResultStats = Pick<PlayerStats, (typeof statKeys)[number]>;

function validateStats(stats: ResultStats, label: string) {
  if (
    statKeys.some(
      (key) =>
        !Number.isInteger(stats[key]) ||
        stats[key] < -2147483648 ||
        stats[key] > 2147483647 ||
        (key !== "elo" && stats[key] < 0)
    )
  ) {
    throw new Error(
      `Invalid or out-of-range stats for ${label}; manual review required.`
    );
  }
}

function afterResult(before: ResultStats, won: boolean): ResultStats {
  const winStreak = won ? before.winStreak + 1 : 0;
  const loseStreak = won ? 0 : before.loseStreak + 1;
  return {
    elo: before.elo,
    wins: before.wins + (won ? 1 : 0),
    losses: before.losses + (won ? 0 : 1),
    winStreak,
    loseStreak,
    biggestWinStreak: Math.max(before.biggestWinStreak, winStreak),
    biggestLosingStreak: Math.max(before.biggestLosingStreak, loseStreak),
  };
}

function validDate(date: Date): boolean {
  return date instanceof Date && Number.isFinite(date.getTime());
}

export async function loadTeamCorrection(
  tx: Prisma.TransactionClient,
  moves: TeamMove[],
  options: CorrectionOptions
) {
  if (
    options.seasonNumber === undefined &&
    (await tx.season.count({ where: { isActive: true } })) > 1
  ) {
    throw new Error(
      "Multiple active seasons found; use --season to select one explicitly after reviewing the data."
    );
  }
  const season = await tx.season.findFirst({
    where:
      options.seasonNumber === undefined
        ? { isActive: true }
        : { number: options.seasonNumber },
    orderBy: { number: "desc" },
  });
  if (!season) throw new Error("Requested/active season not found.");
  const game = await tx.game.findFirst({
    where: { seasonId: season.id, finished: true },
    orderBy: [{ endTime: "desc" }, { startTime: "desc" }, { id: "desc" }],
    include: gameInclude,
  });
  if (!game) throw new Error("No saved finished game found in this season.");
  if (
    (await tx.game.count({
      where: {
        seasonId: season.id,
        finished: true,
        endTime: game.endTime,
        startTime: game.startTime,
      },
    })) > 1
  ) {
    throw new Error(
      "Latest games have identical timestamps; cannot safely select the last game automatically."
    );
  }
  if (
    game.seasonId !== season.id ||
    !game.finished ||
    !validDate(game.startTime) ||
    !validDate(game.endTime) ||
    game.endTime < game.startTime ||
    (game.winner !== Team.RED && game.winner !== Team.BLUE)
  ) {
    throw new Error(
      "Saved game has inconsistent season, dates, or winner; manual review required."
    );
  }
  if (
    season.lifecycleState === "CLOSING" ||
    season.lifecycleState === "CLOSED"
  ) {
    throw new Error(
      "Season is closing/closed; correcting results also requires reviewing awarded season titles. Manual review required."
    );
  }
  if (game.cleanupState === "PENDING") {
    throw new Error(
      "Game cleanup is pending; finish/reconcile shutdown first."
    );
  }
  const removals = options.removePlayers ?? [];
  if (!moves.length && !removals.length)
    throw new Error("Specify at least one player move or removal.");
  const parts = game.gameParticipations;
  if (
    parts.some(
      (p) =>
        !p.player ||
        p.player.id !== p.playerId ||
        !p.player.discordSnowflake ||
        !p.ignUsed.trim() ||
        p.gameId !== game.id ||
        p.seasonId !== season.id ||
        (p.team !== Team.RED && p.team !== Team.BLUE)
    ) ||
    new Set(parts.map((p) => p.playerId)).size !== parts.length ||
    new Set(parts.map((p) => p.player.discordSnowflake)).size !== parts.length
  ) {
    throw new Error(
      "Saved roster has missing, duplicate, or inconsistent player identities."
    );
  }
  if (
    !parts.some((p) => p.team === Team.RED) ||
    !parts.some((p) => p.team === Team.BLUE)
  ) {
    throw new Error(
      "Saved roster must already contain both RED and BLUE teams."
    );
  }
  const changedTeams = new Map<string, Team | null>();
  const actions = [
    ...moves,
    ...removals.map((identifier) => ({ identifier, team: null })),
  ];
  for (const move of actions) {
    if (
      move.team !== null &&
      move.team !== Team.RED &&
      move.team !== Team.BLUE
    ) {
      throw new Error("Destination must be RED or BLUE.");
    }
    const identifier = move.identifier.trim().toLowerCase();
    if (!identifier) throw new Error("Player identifier cannot be empty.");
    const matches = parts.filter((p) =>
      [
        p.ignUsed,
        p.player.latestIGN,
        p.player.discordSnowflake,
        p.playerId,
      ].some((value) => value?.toLowerCase() === identifier)
    );
    if (matches.length !== 1) {
      throw new Error(
        `Player '${move.identifier}' is missing or ambiguous in this game. Use their player ID.`
      );
    }
    const part = matches[0];
    if (changedTeams.has(part.playerId))
      throw new Error(
        "Player specified more than once (including move/remove conflicts)."
      );
    if (move.team === null && part.mvp) {
      throw new Error(
        `Cannot remove MVP '${part.ignUsed}': MVP awards must stay unchanged.`
      );
    }
    changedTeams.set(part.playerId, move.team);
  }
  if (
    !parts.some(
      (p) =>
        changedTeams.has(p.playerId) && changedTeams.get(p.playerId) !== p.team
    )
  ) {
    throw new Error("The requested changes already match the saved teams.");
  }
  const playerIds = parts.map((p) => p.playerId);
  const removedParts = parts.filter(
    (p) => changedTeams.has(p.playerId) && changedTeams.get(p.playerId) === null
  );
  // Remove one occurrence per player, preserving the original display order.
  const participantsIGNs = [...game.participantsIGNs];
  if (
    JSON.stringify([...participantsIGNs].sort()) !==
    JSON.stringify(parts.map((p) => p.ignUsed).sort())
  ) {
    throw new Error(
      "Saved participantsIGNs does not match the roster; manual review required."
    );
  }
  for (const part of removedParts) {
    const index = participantsIGNs.indexOf(part.ignUsed);
    if (index === -1)
      throw new Error(
        "Saved participantsIGNs does not match the removed player; manual review required."
      );
    participantsIGNs.splice(index, 1);
  }
  const otherParts = await tx.gameParticipation.findMany({
    where: {
      seasonId: season.id,
      playerId: { in: playerIds },
      gameId: { not: game.id },
    },
    include: { game: true },
    orderBy: { id: "asc" },
  });
  // A later result depends on this game's Elo. Refuse rather than silently
  // corrupt downstream results, including games with tied timestamps.
  if (
    otherParts.some((p) => !p.game.finished || p.game.endTime >= game.endTime)
  ) {
    throw new Error(
      "A participant has another unfinished or equally/later dated game. Last-game correction is unsafe."
    );
  }
  if (
    otherParts.some(
      (p) =>
        p.gameId !== p.game.id ||
        p.seasonId !== season.id ||
        p.game.seasonId !== season.id ||
        !playerIds.includes(p.playerId) ||
        !validDate(p.game.endTime) ||
        (p.team !== Team.RED && p.team !== Team.BLUE) ||
        (p.game.winner !== Team.RED && p.game.winner !== Team.BLUE) ||
        p.game.cleanupState === "PENDING"
    ) ||
    new Set(otherParts.map((p) => `${p.playerId}:${p.gameId}`)).size !==
      otherParts.length
  ) {
    throw new Error(
      "Prior participation history is inconsistent; manual review required."
    );
  }
  const histories = await tx.eloHistory.findMany({
    where: {
      seasonId: season.id,
      playerId: { in: playerIds },
      gameId: { not: game.id },
    },
    include: { game: true },
    orderBy: { id: "asc" },
  });
  if (
    histories.some((h) => !h.game.finished || h.game.endTime >= game.endTime)
  ) {
    throw new Error("Later or unfinished Elo history exists.");
  }
  if (
    histories.some(
      (h) =>
        h.gameId !== h.game.id ||
        h.seasonId !== season.id ||
        h.game.seasonId !== season.id ||
        !validDate(h.game.endTime) ||
        !Number.isInteger(h.elo) ||
        h.elo < -2147483648 ||
        h.elo > 2147483647 ||
        !otherParts.some(
          (p) => p.playerId === h.playerId && p.gameId === h.gameId
        )
    ) ||
    new Set(histories.map((h) => `${h.playerId}:${h.gameId}`)).size !==
      histories.length
  ) {
    throw new Error(
      "Prior Elo history is orphaned or inconsistent; manual review required."
    );
  }
  const currentStats = await tx.playerStats.findMany({
    where: { seasonId: season.id, playerId: { in: playerIds } },
    orderBy: { id: "asc" },
  });
  if (
    currentStats.length !== parts.length ||
    new Set(currentStats.map((s) => s.playerId)).size !== parts.length ||
    currentStats.some(
      (s) => !playerIds.includes(s.playerId) || s.seasonId !== season.id
    )
  )
    throw new Error("Missing participant seasonal stats.");
  currentStats.forEach((s) => validateStats(s, s.playerId));
  if (game.eloRated == null && !game.eloHistories.length) {
    throw new Error(
      "Legacy game has neither a rated flag nor Elo history; cannot safely infer whether it was unrated."
    );
  }
  const rated = game.eloRated ?? game.eloHistories.length > 0;
  if (
    game.eloHistories.length !== (rated ? parts.length : 0) ||
    new Set(game.eloHistories.map((h) => h.playerId)).size !==
      game.eloHistories.length ||
    game.eloHistories.some(
      (h) =>
        !playerIds.includes(h.playerId) ||
        h.seasonId !== season.id ||
        h.gameId !== game.id ||
        !Number.isInteger(h.elo) ||
        h.elo < -2147483648 ||
        h.elo > 2147483647
    )
  ) {
    throw new Error(
      "Game Elo history is incomplete/inconsistent; manual review required."
    );
  }
  const doubleElo = game.doubleElo ?? options.legacyDoubleElo;
  if (rated && doubleElo === undefined) {
    throw new Error(
      "Legacy game has no doubleElo flag. Specify --double-elo yes or --double-elo no."
    );
  }
  const bases = parts.map((part) => {
    const prior = otherParts
      .filter((p) => p.playerId === part.playerId)
      .sort(
        (a, b) =>
          a.game.endTime.getTime() - b.game.endTime.getTime() ||
          a.gameId.localeCompare(b.gameId)
      );
    const priorHistory = histories
      .filter((h) => h.playerId === part.playerId)
      .sort(
        (a, b) =>
          b.game.endTime.getTime() - a.game.endTime.getTime() ||
          b.gameId.localeCompare(a.gameId)
      );
    for (let i = 0; i < prior.length; i++) {
      const p = prior[i];
      const history = priorHistory.find((h) => h.gameId === p.gameId);
      if (p.game.eloRated !== false && !history) {
        throw new Error(
          `Missing prior rated history (or ambiguous legacy rating) for ${part.ignUsed}.`
        );
      }
      if (p.game.eloRated === false && history) {
        throw new Error(
          `Prior unrated game has Elo history for ${part.ignUsed}.`
        );
      }
      if (
        i > 0 &&
        prior[i - 1].game.endTime.getTime() === p.game.endTime.getTime()
      ) {
        throw new Error(
          `Prior games have tied timestamps for ${part.ignUsed}; cannot safely order streaks.`
        );
      }
    }
    const before = {
      elo: priorHistory[0]?.elo ?? 1000,
      wins: 0,
      losses: 0,
      winStreak: 0,
      loseStreak: 0,
      biggestWinStreak: 0,
      biggestLosingStreak: 0,
    };
    for (const p of prior) {
      Object.assign(before, afterResult(before, p.team === p.game.winner));
    }
    const stored = currentStats.find((s) => s.playerId === part.playerId)!;
    const expected = afterResult(before, part.team === game.winner);
    expected.elo = rated
      ? game.eloHistories.find((h) => h.playerId === part.playerId)!.elo
      : before.elo;
    if (statKeys.some((key) => stored[key] !== expected[key])) {
      throw new Error(
        `Current stats do not match saved results for ${part.ignUsed}; refusing to overwrite unrelated or missing changes.`
      );
    }
    return {
      part,
      before,
      team: changedTeams.has(part.playerId)
        ? (changedTeams.get(part.playerId) ?? null)
        : part.team,
      player: {
        ...before,
        playerId: part.playerId,
        latestIGN: part.ignUsed,
      } as PlayerInstance,
    };
  });
  if (
    !bases.some((b) => b.team === Team.RED) ||
    !bases.some((b) => b.team === Team.BLUE)
  ) {
    throw new Error("Both corrected teams must contain at least one player.");
  }
  const mean = (team: Team) =>
    EloUtil.calculateMeanElo(
      bases.filter((b) => b.team === team).map((b) => b.player)
    );
  const blueMeanElo = mean(Team.BLUE),
    redMeanElo = mean(Team.RED);
  const [blueExpectedScore, redExpectedScore] = EloUtil.calculateExpectedScore(
    blueMeanElo,
    redMeanElo
  );
  const context: EloGameContext = {
    blueMeanElo,
    redMeanElo,
    blueExpectedScore,
    redExpectedScore,
    getPlayersTeam: (player) =>
      bases.find((b) => b.player === player)?.team ?? null,
  };
  const config = ConfigManager.getConfig();
  const eloConfig = {
    mvpBonus: config.mvpBonus,
    captainBonus: config.captainBonus,
    underdogMultiplier: config.underdogMultiplier,
  };
  if (
    rated &&
    Object.values(eloConfig).some(
      (value) => !Number.isFinite(value) || value < 0
    )
  ) {
    throw new Error(
      "Elo bonuses and multipliers must be finite, nonnegative numbers."
    );
  }
  const updates = bases.map(({ part, before, team, player }) => {
    const removed = team === null;
    const won = team === game.winner;
    const winStreak = removed
      ? before.winStreak
      : won
        ? before.winStreak + 1
        : 0;
    const loseStreak = removed
      ? before.loseStreak
      : won
        ? 0
        : before.loseStreak + 1;
    const delta =
      rated && !removed
        ? EloUtil.calculateEloChange(context, player, won, winStreak)
        : 0;
    const elo =
      rated && !removed
        ? Math.round(
            before.elo +
              (won ? delta * (doubleElo ? 2 : 1) : -delta) +
              (part.mvp ? config.mvpBonus : 0) +
              (part.captain ? config.captainBonus : 0) +
              (part.votedForAMVP ? 1 : 0)
          )
        : before.elo;
    return {
      participationId: part.id,
      playerId: part.playerId,
      ign: part.ignUsed,
      from: part.team,
      to: team,
      mvp: part.mvp,
      captain: part.captain,
      votedForAMVP: part.votedForAMVP,
      old: currentStats.find((s) => s.playerId === part.playerId)!,
      history: game.eloHistories.find((h) => h.playerId === part.playerId),
      next: {
        elo,
        wins: before.wins + (!removed && won ? 1 : 0),
        losses: before.losses + (!removed && !won ? 1 : 0),
        winStreak,
        loseStreak,
        biggestWinStreak: Math.max(before.biggestWinStreak, winStreak),
        biggestLosingStreak: Math.max(before.biggestLosingStreak, loseStreak),
      },
    };
  });
  updates.forEach((u) => validateStats(u.next, u.ign));
  // Include the source records as well as the result so confirmation cannot
  // apply a preview based on changed game details, history, or seasonal stats.
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        season,
        game,
        otherParts,
        histories,
        currentStats,
        updates,
        eloConfig,
      })
    )
    .digest("hex");
  return {
    game,
    season,
    rated,
    doubleElo,
    updates,
    participantsIGNs,
    revision,
  };
}

export type TeamCorrectionPlan = Awaited<ReturnType<typeof loadTeamCorrection>>;
export type CorrectionTransaction = <T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>
) => Promise<T>;

/** No automatic retry: losing a commit acknowledgement does not prove rollback. */
export async function commitTeamCorrection(
  transaction: CorrectionTransaction,
  preview: TeamCorrectionPlan,
  moves: TeamMove[],
  options: CorrectionOptions
): Promise<void> {
  try {
    await transaction((tx) => applyTeamCorrection(tx, preview, moves, options));
  } catch (error) {
    throw new Error(
      `Correction was not confirmed: ${error instanceof Error ? error.message : "database error"}. Inspect a fresh preview without --apply before retrying; a lost connection can hide a successful commit.`
    );
  }
}

/** Caller must supply one interactive transaction for revalidation and all writes. */
export async function applyTeamCorrection(
  tx: Prisma.TransactionClient,
  preview: TeamCorrectionPlan,
  moves: TeamMove[],
  options: CorrectionOptions
) {
  let plan: TeamCorrectionPlan;
  try {
    plan = await loadTeamCorrection(tx, moves, options);
  } catch (error) {
    throw new Error(
      `Game or stats changed since preview, or revalidation failed: ${error instanceof Error ? error.message : "unknown validation failure"}`
    );
  }
  if (plan.revision !== preview.revision) {
    throw new Error(
      "Game or stats changed since preview. Nothing applied; preview again."
    );
  }
  for (const update of plan.updates) {
    if (update.to === null) {
      if (update.history) {
        await tx.eloHistory.delete({ where: { id: update.history.id } });
      }
      await tx.gameParticipation.delete({
        where: { id: update.participationId },
      });
    } else if (update.from !== update.to) {
      await tx.gameParticipation.update({
        where: { id: update.participationId },
        data: { team: update.to },
      });
    }
    const changed = await tx.playerStats.updateMany({
      where: {
        id: update.old.id,
        ...Object.fromEntries(statKeys.map((key) => [key, update.old[key]])),
      },
      data: update.next,
    });
    if (changed.count !== 1)
      throw new Error(
        `Concurrent stats change for ${update.ign}; transaction must roll back.`
      );
    if (update.to !== null && plan.rated && update.history) {
      await tx.eloHistory.update({
        where: { id: update.history.id },
        data: { elo: update.next.elo },
      });
    }
  }
  if (plan.updates.some((u) => u.to === null)) {
    await tx.game.update({
      where: { id: plan.game.id },
      data: { participantsIGNs: plan.participantsIGNs },
    });
  }
  // Keep Game (including its original persistence receipt), participation
  // flags, record IDs, and history timestamps intact for remaining players.
}
