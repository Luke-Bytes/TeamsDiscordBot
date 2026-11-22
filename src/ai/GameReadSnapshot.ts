import { GameInstance } from "../database/GameInstance";
import { CurrentGameManager } from "../logic/CurrentGameManager";
import { GameRecoveryCoordinator } from "../logic/ActiveGameRecovery";
import { MatchRecoveryGate } from "../logic/MatchRecoveryGate";
import TeamCommand from "../commands/TeamCommand";

export type GameStateAudience = "player" | "organiser";

/** Shared lifecycle interpretation; consult this rather than inferring stages from a message. */
export function gameLifecycle(
  game: GameInstance
):
  | "inactive"
  | "announced"
  | "starting"
  | "started"
  | "finished"
  | "awaiting cleanup or shutdown" {
  if (game.isRestarting) return "awaiting cleanup or shutdown";
  if (game.isFinished) return "finished";
  if (!game.announced) return "inactive";
  if (game.getGameStartStatus() === "starting") return "starting";
  if (game.getGameStartStatus() === "started") return "started";
  return "announced";
}

/**
 * One synchronous observation from the current bot process. Audience is chosen
 * by the server after fresh guild membership verification, never by model input.
 * No DB/HTTP/Discord I/O, recovery actions or write operations.
 */
export function getCurrentGameStateSnapshot(audience: GameStateAudience) {
  const game = CurrentGameManager.getCurrentGame();
  const lifecycle = gameLifecycle(game);
  const active = lifecycle !== "inactive";
  const stage = game.getGameStartStatus();
  const red = game.getPlayersOfTeam("RED").length;
  const blue = game.getPlayersOfTeam("BLUE").length;
  const undecided = game.getPlayersOfTeam("UNDECIDED").length;
  const playable = game.hasFinalizedPlayableTeams();
  const session = TeamCommand.instance?.teamPickingSession;
  const sessionState = session?.state;
  const teamStage = !active
    ? "no active game"
    : playable
      ? "finalised"
      : sessionState === "inProgress"
        ? "being picked"
        : red + blue > 0
          ? "partly allocated"
          : "pending";
  const startTime =
    game.startTime instanceof Date && Number.isFinite(game.startTime.getTime())
      ? game.startTime.toISOString()
      : null;
  const map =
    typeof game.settings.map === "string" &&
    /^[A-Z_]{2,32}$/.test(game.settings.map)
      ? game.settings.map
      : null;
  const minerushName = game.settings.modifiers.find(
    (entry) => entry.category === "Minerushing"
  )?.name;
  const minerushSetting =
    minerushName === "Always" || minerushName === "Not before phase 3 (Three)"
      ? minerushName
      : "not confirmed";
  const publicSnapshot = {
    status: "ok" as const,
    source: "current bot process snapshot" as const,
    observedAt: new Date().toISOString(),
    audience,
    active,
    lifecycle,
    scheduledStart: active ? startTime : null,
    registration: {
      count: active ? game.getRegisteredPlayerCount() : 0,
      status: !active
        ? "no game announced"
        : lifecycle === "announced"
          ? "stage-dependent; sign-up availability not independently verified"
          : "not confirmed open",
    },
    teams: {
      stage: teamStage,
      red: active ? red : 0,
      blue: active ? blue : 0,
      undecided: active ? undecided : 0,
    },
    match: {
      started: stage === "started" || Boolean(game.isFinished),
      finished: Boolean(game.isFinished),
    },
    settings: {
      map: active ? map : null,
      minerush: active ? minerushSetting : "not applicable",
    },
    uncertainty: [
      "This is process memory, not proof of database persistence or successful Discord message delivery.",
      "Registration availability, active polls and timer execution are not externally verified.",
    ],
  };
  if (audience === "player") return publicSnapshot;

  const redCaptain = game.getCaptainOfTeam("RED");
  const blueCaptain = game.getCaptainOfTeam("BLUE");
  const recoveryBlocked = Boolean(
    MatchRecoveryGate.getBlockReason() ??
      GameRecoveryCoordinator.getBlockReason()
  );
  const activeTeamSession = sessionState === "inProgress";
  const pendingBans =
    active && game.getClassBanLimit() > 0 && !game.areClassBansAnnounced();
  const startChecks = [
    ...(!active ? ["Confirm that a game has been announced."] : []),
    ...(active && !playable
      ? [
          "Review team allocations and finalise playable teams using the normal commands.",
        ]
      : []),
    ...(recoveryBlocked
      ? [
          "Do not retry lifecycle actions; escalate the recovery block to an operator.",
        ]
      : []),
    ...(pendingBans
      ? ["Check class bans and their normal deadline before starting."]
      : []),
    ...(game.recoveryDraftProgress
      ? [
          "Recovered draft is paused; do not assume old picks or timers can continue automatically.",
        ]
      : []),
  ];
  return {
    ...publicSnapshot,
    lifecycleSubstage: {
      gameStartStatus: stage,
      shutdownOrCleanupInProgress: Boolean(game.isRestarting),
      pausedWorkflows: game.recoveryPausedWorkflows.length,
      recoveredDraftPaused: Boolean(game.recoveryDraftProgress),
      recordedEndTime: game.endTime?.toISOString() ?? null,
      winnerInMemory: game.gameWinner ?? null,
    },
    announcedConfiguration: {
      organiserBans: game.settings.organiserBannedClasses.length,
      banMode: game.classBanMode,
      delayedBan: game.settings.delayedBan,
      modifierMode: game.modifierMode,
      modifiers: game.settings.modifiers
        .slice(0, 8)
        .map(({ category, name }) => ({
          category: category.slice(0, 32),
          name: name.slice(0, 48),
        })),
      doubleElo: game.isDoubleElo,
      noElo: game.noElo,
      relaxedSeason: game.isRelaxedSeason,
    },
    teams: {
      ...publicSnapshot.teams,
      playable,
      method: game.teamsDecidedBy ?? "not finalised",
    },
    captains: {
      redAssigned: Boolean(redCaptain),
      blueAssigned: Boolean(blueCaptain),
    },
    teamPicking: {
      sessionPresent: Boolean(session),
      sessionStatus:
        sessionState === "inProgress"
          ? "in progress"
          : sessionState === "cancelled"
            ? "cancelled"
            : session
              ? "present (completion not verified)"
              : "not present",
    },
    classBans: {
      requiredPerCaptain: game.getPerCaptainBanLimit(),
      redRecorded: redCaptain
        ? game.getCaptainBanCount(redCaptain.discordSnowflake)
        : null,
      blueRecorded: blueCaptain
        ? game.getCaptainBanCount(blueCaptain.discordSnowflake)
        : null,
      redWindowLocked: redCaptain
        ? game.isCaptainBanLocked(redCaptain.discordSnowflake)
        : null,
      blueWindowLocked: blueCaptain
        ? game.isCaptainBanLocked(blueCaptain.discordSnowflake)
        : null,
      announcedInMemory: game.areClassBansAnnounced(),
      readiness:
        game.getClassBanLimit() === 0
          ? "not required"
          : game.areClassBansAnnounced()
            ? "announcement recorded in memory (delivery unverified)"
            : "pending or unverified",
    },
    polls: {
      map: {
        managerPresent: Boolean(game.mapVoteManager),
        messageReferencePresent: Boolean(game.mapVoteManager?.pollMessage),
        open: "unverified",
      },
      minerush: {
        managerPresent: Boolean(game.minerushVoteManager),
        messageReferencePresent: Boolean(game.minerushVoteManager?.pollMessage),
        open: "unverified",
      },
    },
    expectedDeadlines: {
      source: "scheduled start arithmetic, not evidence a callback ran",
      captainReminder: game.startTime
        ? new Date(game.startTime.getTime() - 20 * 60_000).toISOString()
        : null,
      captainSelection: game.startTime
        ? new Date(game.startTime.getTime() - 15 * 60_000).toISOString()
        : null,
      mapVoteClose: game.startTime
        ? new Date(game.startTime.getTime() - 10 * 60_000).toISOString()
        : null,
      minerushVoteClose: game.startTime
        ? new Date(game.startTime.getTime() - 5 * 60_000).toISOString()
        : null,
      classBanDeadline: game.startTime?.toISOString() ?? null,
    },
    timers: {
      classWarningHandlePresent: Boolean(
        CurrentGameManager.classBanWarningTimeout
      ),
      classDeadlineHandlePresent: Boolean(
        CurrentGameManager.classBanDeadlineTimeout
      ),
      captainReminderHandlePresent: Boolean(
        CurrentGameManager.captainReminderTimeout
      ),
      captainSelectionHandlePresent: Boolean(
        CurrentGameManager.captainEnforceTimeout
      ),
      draftAutoStartHandlePresent: Boolean(
        CurrentGameManager.draftAutoStartTimeout
      ),
      execution: "unverified; a handle does not prove execution",
    },
    readiness: {
      teamsPlayable: playable,
      startConditionsInMemory:
        active &&
        lifecycle === "announced" &&
        playable &&
        !recoveryBlocked &&
        !activeTeamSession &&
        !game.recoveryDraftProgress,
      cautions: [
        ...(activeTeamSession ? ["draft or picking is still active"] : []),
        ...(game.recoveryDraftProgress
          ? [
              "draft was recovered in a paused state; manual operator review required",
            ]
          : []),
        ...(!redCaptain || !blueCaptain
          ? ["one or both captains are missing"]
          : []),
        ...(pendingBans
          ? ["class ban announcement not recorded; window may still be open"]
          : []),
        ...(game.getGameStartStatus() === "starting"
          ? ["game start is in progress; Discord operations may be partial"]
          : []),
        ...(game.isRestarting ? ["shutdown in progress or unresolved"] : []),
        ...(recoveryBlocked
          ? ["recovery gate blocks safe lifecycle progress"]
          : []),
      ].slice(0, 6),
      startCompletion:
        stage === "started"
          ? "in-memory transition completed; Discord actions unverified"
          : "not confirmed",
      end: game.isFinished
        ? "end recorded in memory"
        : "end not recorded in memory",
      shutdown: game.isRestarting
        ? "cleanup/shutdown may be underway or unresolved"
        : game.isFinished
          ? "post-game processing or shutdown may still be required"
          : "not indicated",
    },
    recoveryBlocked,
    persistence: "unknown (not queried)",
    externalCleanup: "unverified (Discord and database not inspected)",
    suggestedNextCheck: "/game diagnostics (organiser-only read-only command)",
    recommendedNextChecks: startChecks.length
      ? startChecks.slice(0, 3)
      : game.isFinished
        ? [
            "Check the ordinary post-game and shutdown workflow, and verify saved state separately.",
          ]
        : [
            "Use /game diagnostics and confirm the current roster, poll and Discord state before acting.",
          ],
  };
}

/** Kept for callers of the original organiser-only tool. */
export function getOrganiserGameSnapshot() {
  return getCurrentGameStateSnapshot("organiser");
}
