import { createHash } from "node:crypto";
import {
  gameType,
  MatchCleanupState,
  Game,
  Prisma,
  SeasonType,
  Team,
  UnratedGameReason,
} from "@prisma/client";
import type { GameInstance } from "./GameInstance";
import { Elo } from "../logic/Elo";
import { CurrentGameManager } from "../logic/CurrentGameManager";

export type MatchStore = {
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  findCommitted(matchId: string): Promise<Game | null>;
};

export class MatchCommitUncertainError extends Error {
  constructor(readonly matchId: string, readonly cause: unknown) {
    super(
      `Match ${matchId} was not confirmed committed. Do not retry from a new game or reset; inspect the database transaction and match ID with an operator.`
    );
    this.name = "MatchCommitUncertainError";
  }
}

/**
 * A single match has one primary-key claim and one multi-document transaction.
 * A standalone MongoDB deployment cannot execute this safely: it must fail
 * rather than run a non-transactional fallback.
 */
export async function persistCompletedMatch(
  game: GameInstance,
  db: MatchStore
): Promise<Game> {
  const token = game.getLifecycleToken();
  const matchId = game.gameId ?? token;
  if (
    !game.announced ||
    !game.isFinished ||
    !game.endTime ||
    !game.startTime ||
    !game.hasFinalizedPlayableTeams() ||
    (game.gameWinner !== Team.RED && game.gameWinner !== Team.BLUE) ||
    CurrentGameManager.getCurrentGame() !== game
  ) {
    throw new Error(`Match ${matchId} is not eligible for persistence`);
  }

  const winner = game.gameWinner;
  const participants = [
    ...game.teams.RED.map((player) => ({ player, team: Team.RED })),
    ...game.teams.BLUE.map((player) => ({ player, team: Team.BLUE })),
  ].map(({ player, team }) => ({
    player,
    team,
    playerId: player.playerId,
    snowflake: player.discordSnowflake,
    ignUsed: player.ignUsed ?? "UnknownIGN",
    captain: player.captain === true,
    draftSlotPlacement: player.draftSlotPlacement ?? undefined,
    mvp:
      (team === Team.RED && game.MVPPlayerRed === player.ignUsed) ||
      (team === Team.BLUE && game.MVPPlayerBlue === player.ignUsed),
    votedForAMVP: game.hasVotedMvp(player.discordSnowflake),
    before: {
      elo: player.elo,
      wins: player.wins,
      losses: player.losses,
      winStreak: player.winStreak,
      loseStreak: player.loseStreak,
      biggestWinStreak: player.biggestWinStreak,
      biggestLosingStreak: player.biggestLosingStreak,
    },
  }));

  if (
    participants.some((p) => !p.playerId || !p.snowflake) ||
    new Set(participants.map((p) => p.playerId)).size !== participants.length ||
    new Set(participants.map((p) => p.snowflake)).size !== participants.length
  ) {
    throw new Error(`Match ${matchId} has missing or duplicate participants`);
  }

  const settings = {
    organiserBannedClasses: [...(game.settings.organiserBannedClasses ?? [])],
    sharedCaptainBannedClasses: [...(game.settings.sharedCaptainBannedClasses ?? [])],
    nonSharedCaptainBannedClasses: {
      RED: [...(game.settings.nonSharedCaptainBannedClasses?.RED ?? [])],
      BLUE: [...(game.settings.nonSharedCaptainBannedClasses?.BLUE ?? [])],
    },
    map: game.settings.map ?? "DUELSTAL" as const,
    modifiers: game.settings.modifiers.map((m) => ({ ...m })),
    delayedBan: game.settings.delayedBan ?? 0,
  };
  const snapshot = {
    matchId,
    token,
    startTime: game.startTime,
    endTime: game.endTime,
    winner,
    settings,
    organiser: game.organiser ?? "Unknown",
    host: game.host ?? "Unknown",
    teamsDecidedBy: game.teamsDecidedBy ?? null,
    isDoubleElo: game.isDoubleElo,
    noElo: game.noElo,
    redTeamPlan: game.redTeamPlan ?? null,
    blueTeamPlan: game.blueTeamPlan ?? null,
    participants: participants.map(({ player: _player, ...data }) => data),
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");

  const checkExisting = (record: Game): Game => {
    if (!record.finished || record.persistenceFingerprint !== fingerprint) {
      throw new Error(
        `Match ${matchId} already exists with different or legacy contents; manual reconciliation required`
      );
    }
    return record;
  };

  try {
    return await db.transaction(
      async (tx) => {
        const existing = await tx.game.findUnique({ where: { id: matchId } });
        if (existing) return checkExisting(existing);

        const season = await tx.season.findFirst({
          where: { isActive: true },
          orderBy: { number: "desc" },
        });
        if (!season) throw new Error("No active season found");
        const eloRated =
          season.type !== SeasonType.RELAXED && !snapshot.noElo;
        const unratedReason =
          season.type === SeasonType.RELAXED
            ? UnratedGameReason.RELAXED_SEASON
            : snapshot.noElo
              ? UnratedGameReason.LOW_PLAYER_COUNT
              : null;
        const elo = new Elo();
        const updates = [];
        for (const participant of participants) {
          const storedPlayer = await tx.player.findUnique({
            where: { discordSnowflake: participant.snowflake },
          });
          if (!storedPlayer || storedPlayer.id !== participant.playerId) {
            throw new Error(`Match ${matchId} participant identity changed; aborting`);
          }
          let stats = await tx.playerStats.findUnique({
            where: {
              playerId_seasonId: {
                playerId: participant.playerId,
                seasonId: season.id,
              },
            },
          });
          if (!stats) {
            // Older registrations can lack a current-season stats document.
            // Create the standard default *inside the match transaction* only
            // when the captured player snapshot also has those defaults.
            const fresh = {
              elo: 1000,
              wins: 0,
              losses: 0,
              winStreak: 0,
              loseStreak: 0,
              biggestWinStreak: 0,
              biggestLosingStreak: 0,
            };
            if (Object.entries(fresh).some(
              ([field, value]) =>
                participant.before[field as keyof typeof fresh] !== value
            )) {
              throw new Error(`Match ${matchId} stats absent with non-default snapshot`);
            }
            stats = await tx.playerStats.create({
              data: {
                playerId: participant.playerId,
                seasonId: season.id,
                elo: 1000,
              },
            });
          }
          if (Object.entries(participant.before).some(
            ([field, value]) =>
              stats[field as keyof typeof participant.before] !== value
          )) {
            throw new Error(`Match ${matchId} participant stats changed; aborting`);
          }
          const isWinner = participant.team === winner;
          const nextWinStreak = isWinner ? stats.winStreak + 1 : 0;
          const nextLoseStreak = isWinner ? 0 : stats.loseStreak + 1;
          // Elo originally used the *post-win* streak. Supply it as an override,
          // preserving all game calculations without changing PlayerInstance.
          const nextElo = eloRated
            ? elo.calculateNewElo(participant.player, nextWinStreak)
            : stats.elo;
          updates.push({
            stats,
            participant,
            next: {
              elo: nextElo,
              wins: stats.wins + (isWinner ? 1 : 0),
              losses: stats.losses + (isWinner ? 0 : 1),
              winStreak: nextWinStreak,
              loseStreak: nextLoseStreak,
              biggestWinStreak: Math.max(stats.biggestWinStreak, nextWinStreak),
              biggestLosingStreak: Math.max(stats.biggestLosingStreak, nextLoseStreak),
            },
          });
        }

        if (game.getLifecycleToken() !== token) {
          throw new Error(`Match ${matchId} lifecycle changed before commit`);
        }

        // CREATE, never UPSERT: the immutable game ID claims the entire match.
        // Every dependent write below is in the *same MongoDB transaction*.
        const record = await tx.game.create({
          data: {
            id: matchId,
            finished: true,
            startTime: snapshot.startTime,
            endTime: snapshot.endTime,
            settings: snapshot.settings,
            winner,
            type: snapshot.teamsDecidedBy as gameType | null,
            organiser: snapshot.organiser,
            host: snapshot.host,
            doubleElo: snapshot.isDoubleElo,
            eloRated,
            unratedReason,
            participantsIGNs: participants.map((p) => p.ignUsed),
            redTeamPlan: snapshot.redTeamPlan ?? undefined,
            blueTeamPlan: snapshot.blueTeamPlan ?? undefined,
            persistenceFingerprint: fingerprint,
            cleanupState: MatchCleanupState.PENDING,
            season: { connect: { id: season.id } },
          },
        });

        for (const { stats, participant, next } of updates) {
          // Compare-and-swap blocks writes from a stale in-memory match snapshot.
          const changed = await tx.playerStats.updateMany({
            where: {
              id: stats.id,
              elo: stats.elo,
              wins: stats.wins,
              losses: stats.losses,
              winStreak: stats.winStreak,
              loseStreak: stats.loseStreak,
              biggestWinStreak: stats.biggestWinStreak,
              biggestLosingStreak: stats.biggestLosingStreak,
            },
            data: next,
          });
          if (changed.count !== 1) {
            throw new Error(`Match ${matchId} concurrent stats update detected`);
          }

          await tx.gameParticipation.create({
            data: {
              gameId: matchId,
              playerId: participant.playerId,
              seasonId: season.id,
              ignUsed: participant.ignUsed,
              team: participant.team,
              mvp: participant.mvp,
              votedForAMVP: participant.votedForAMVP,
              captain: participant.captain,
              draftSlotPlacement: participant.draftSlotPlacement,
            },
          });
          if (eloRated) {
            await tx.eloHistory.create({
              data: {
                gameId: matchId,
                playerId: participant.playerId,
                seasonId: season.id,
                elo: next.elo,
              },
            });
          }
        }
        return record;
      }
    );
  } catch (cause) {
    // A lost commit acknowledgement does NOT prove rollback. Only a durable
    // same-fingerprint game can prove completion; otherwise require a human.
    try {
      const committed = await db.findCommitted(matchId);
      if (committed) return checkExisting(committed);
    } catch {
      // The read can also fail or expose incompatible prior contents.
    }
    throw new MatchCommitUncertainError(matchId, cause);
  }
}
