import { GameInstance } from "../database/GameInstance";
import { CurrentGameManager } from "./CurrentGameManager";
import { GameRecoveryCoordinator } from "./ActiveGameRecovery";
import { MatchRecoveryGate } from "./MatchRecoveryGate";
import TeamCommand from "../commands/TeamCommand";

/** In-memory, read-only organiser snapshot. No DB, Discord fetch, or scheduler calls. */
export function formatGameDiagnostics(game: GameInstance): string {
  const active = game.announced || game.isFinished || game.isRestarting;
  const status = !active
    ? "inactive"
    : game.isRestarting
      ? "awaiting cleanup / shutdown"
      : game.isFinished
        ? "finished"
        : game.getGameStartStatus() === "starting"
          ? "starting"
          : game.getGameStartStatus() === "started"
            ? "started"
            : "announced";

  const red = game.getPlayersOfTeam("RED").length;
  const blue = game.getPlayersOfTeam("BLUE").length;
  const undecided = game.getPlayersOfTeam("UNDECIDED").length;
  const session = TeamCommand.instance?.teamPickingSession;
  const captainRed = game.getCaptainOfTeam("RED");
  const captainBlue = game.getCaptainOfTeam("BLUE");
  const mapPoll = game.mapVoteManager;
  const minerushPoll = game.minerushVoteManager;
  const minerushSetting = game.settings.modifiers.find((m) => m.category === "Minerushing");
  const block = MatchRecoveryGate.getBlockReason() ?? GameRecoveryCoordinator.getBlockReason();
  const timer = (handle: unknown) => handle ? "handle present (pending unknown)" : "no handle";
  const time = game.startTime && Number.isFinite(game.startTime.getTime())
    ? `<t:${Math.floor(game.startTime.getTime() / 1000)}:F>`
    : "Unknown / not set";

  return [
    "**Game diagnostics (in-memory)**",
    `**Lifecycle:** ${status} | active: ${active ? "yes" : "no"}`,
    `**Correlation ID:** ${active ? (game.gameId ?? game.getLifecycleToken()) : "N/A (no active game)"}`,
    `**Scheduled start:** ${time}`,
    `**Players:** ${game.getRegisteredPlayerCount()} registered (RED ${red}, BLUE ${blue}, UNDECIDED ${undecided})`,
    `**Team picking:** ${game.teamsDecidedBy ?? (session?.state ?? "not finalised")} | playable teams: ${game.hasFinalizedPlayableTeams() ? "yes" : "no"}`,
    `**Captains:** RED ${captainRed ? "assigned" : "missing"}, BLUE ${captainBlue ? "assigned" : "missing"}`,
    `**Map:** ${game.settings.map ?? "Unknown / not selected"} | poll: ${mapPoll ? (mapPoll.pollMessage ? "message present (open/closed unknown)" : "manager present; message unavailable") : "not tracked"}`,
    `**Minerush:** ${minerushSetting?.name ?? "Unknown / not selected"} | poll: ${minerushPoll ? (minerushPoll.pollMessage ? "message present (open/closed unknown)" : "manager present; message unavailable") : "not tracked"}`,
    `**Class bans:** ${game.areClassBansAnnounced() ? "announced" : "not announced"} | RED ${captainRed ? game.getCaptainBanCount(captainRed.discordSnowflake) : "N/A"}, BLUE ${captainBlue ? game.getCaptainBanCount(captainBlue.discordSnowflake) : "N/A"} (per captain limit ${game.getPerCaptainBanLimit()})`,
    `**Timers:** class warning ${timer(CurrentGameManager.classBanWarningTimeout)}, class deadline ${timer(CurrentGameManager.classBanDeadlineTimeout)}, captain reminder ${timer(CurrentGameManager.captainReminderTimeout)}, captain selection ${timer(CurrentGameManager.captainEnforceTimeout)}`,
    `**Recovery block:** ${block ? "yes (see server logs)" : "none reported"} | paused workflows: ${game.recoveryPausedWorkflows.length ? game.recoveryPausedWorkflows.length : "none"}`,
    `**Persistence / external cleanup:** ${game.isRestarting ? "shutdown in progress or unresolved" : "Unknown (not queried; database state is not inspected)"}`,
  ].join("\n");
}
