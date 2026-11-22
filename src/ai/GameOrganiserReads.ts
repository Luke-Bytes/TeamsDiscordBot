import { CurrentGameManager } from "../logic/CurrentGameManager";
import { DraftTeamPickingSession } from "../logic/teams/DraftTeamPickingSession";
import TeamCommand from "../commands/TeamCommand";

/** Bounded organiser-only detail; never send Discord snowflakes or player database IDs. */
const ign = (name: string | null | undefined) =>
  name && /^[A-Za-z0-9_]{3,16}$/.test(name) ? name : "Unknown";

export function getGameOrganiserRoster() {
  const game = CurrentGameManager.getCurrentGame();
  const players = ["RED", "BLUE", "UNDECIDED"] as const;
  const limit = 24;
  let remaining = limit;
  const rosters = Object.fromEntries(
    players.map((team) => {
      const members = game.getPlayersOfTeam(team);
      const displayed = members.slice(0, remaining).map((player) => ({
        latestIGN: ign(player.latestIGN),
        ...(player.ignUsed && player.ignUsed !== player.latestIGN
          ? { registeredAs: ign(player.ignUsed) }
          : {}),
        captain: player.captain === true,
      }));
      remaining -= displayed.length;
      return [team, { total: members.length, players: displayed }];
    })
  );
  const session = TeamCommand.instance?.teamPickingSession;
  const liveDraft =
    session instanceof DraftTeamPickingSession && session.state === "inProgress"
      ? session
      : null;
  const draft = liveDraft
    ? {
        source: "active in-memory draft session",
        turn: liveDraft.turn ?? null,
        finishedPicking: liveDraft.finishedPicking,
        proposed: {
          RED: liveDraft.proposedTeams.RED.length,
          BLUE: liveDraft.proposedTeams.BLUE.length,
          UNDECIDED: liveDraft.proposedTeams.UNDECIDED.length,
        },
        lateSignups: liveDraft.lateSignups.length,
        pickTimer: "execution unverified",
      }
    : game.recoveryDraftProgress
      ? {
          source: "paused recovery record; not automatically resumed",
          turn: game.recoveryDraftProgress.turn,
          finishedPicking: game.recoveryDraftProgress.finishedPicking,
          proposed: {
            RED: game.recoveryDraftProgress.proposedTeams.RED.length,
            BLUE: game.recoveryDraftProgress.proposedTeams.BLUE.length,
            UNDECIDED:
              game.recoveryDraftProgress.proposedTeams.UNDECIDED.length,
          },
          lateSignups: game.recoveryDraftProgress.lateSignups.length,
          pickTimer: "not resumed",
        }
      : null;
  const red = game.getCaptainOfTeam("RED");
  const blue = game.getCaptainOfTeam("BLUE");
  const classBans = {
    mode: game.classBanMode ?? "not set",
    requiredPerCaptain: game.getPerCaptainBanLimit(),
    red: {
      captain: red ? ign(red.latestIGN ?? red.ignUsed) : null,
      recorded: red ? game.getCaptainBanCount(red.discordSnowflake) : null,
      locked: red ? game.isCaptainBanLocked(red.discordSnowflake) : null,
    },
    blue: {
      captain: blue ? ign(blue.latestIGN ?? blue.ignUsed) : null,
      recorded: blue ? game.getCaptainBanCount(blue.discordSnowflake) : null,
      locked: blue ? game.isCaptainBanLocked(blue.discordSnowflake) : null,
    },
    organiser: game.settings.organiserBannedClasses.slice(0, 20),
    shared: game.settings.sharedCaptainBannedClasses.slice(0, 20),
    redOpponentOnly: game.settings.nonSharedCaptainBannedClasses.RED.slice(
      0,
      20
    ),
    blueOpponentOnly: game.settings.nonSharedCaptainBannedClasses.BLUE.slice(
      0,
      20
    ),
    announcedInMemory: game.areClassBansAnnounced(),
  };
  return {
    status: "ok",
    source: "current process memory; no Discord verification",
    announced: game.announced,
    playable: game.hasFinalizedPlayableTeams(),
    teamsDecidedBy: game.teamsDecidedBy ?? null,
    rosters,
    truncated: game.getPlayers().length > limit,
    draft,
    captainNominations: game.captainNominations.size,
    lateSignups: game.lateSignups.size,
    classBans,
    result: {
      finishedInMemory: Boolean(game.isFinished),
      winnerInMemory: game.gameWinner ?? null,
      endedAt: game.endTime?.toISOString() ?? null,
      mvpVotesRecorded: {
        RED: Object.keys(game.mvpVotes.RED).length,
        BLUE: Object.keys(game.mvpVotes.BLUE).length,
      },
      mvpSelections: {
        RED: game.MVPPlayerRed ? "selected in memory" : "not selected",
        BLUE: game.MVPPlayerBlue ? "selected in memory" : "not selected",
      },
    },
    note: "A finalised roster, captain ban, MVP or winner is not independently confirmed in Discord or the database.",
  };
}
