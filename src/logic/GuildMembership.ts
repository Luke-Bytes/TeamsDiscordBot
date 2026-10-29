import { Guild } from "discord.js";
import { CurrentGameManager } from "./CurrentGameManager";
import { DraftTeamPickingSession } from "./teams/DraftTeamPickingSession";
import { fetchGuildMember } from "../util/DiscordFailures";
import type TeamCommand from "../commands/TeamCommand";

/** The active game's roster is mutable only before game start. */
export class GuildMembership {
  static async handleDeparture(userId: string, teamCommand: TeamCommand): Promise<boolean> {
    const game = CurrentGameManager.getCurrentGame();
    if (!game.announced || game.isFinished || game.getGameStartStatus() !== "idle") {
      return false;
    }
    const player = game.getPlayers().find((p) => p.discordSnowflake === userId);
    if (!player) return false;

    const session = teamCommand.teamPickingSession;
    const isCaptain = Boolean(player.captain) ||
      (session instanceof DraftTeamPickingSession &&
        [session.redCaptain?.discordSnowflake, session.blueCaptain?.discordSnowflake].includes(userId));

    // Roster removal is authoritative even if a Discord display cannot be updated.
    try {
      if (isCaptain && session instanceof DraftTeamPickingSession && session.state === "inProgress") {
        await teamCommand.resetTeamPickingSession();
        console.warn(`Draft cancelled because captain left member=${userId}`);
      } else {
        await session?.handleUnregister?.(userId);
      }
    } catch (error) {
      console.error(`Departure session cleanup failed member=${userId}`, error);
    }
    await game.removePlayerByDiscordId(userId);
    if (game.teamsDecidedBy) {
      game.changeHowTeamsDecided(null);
      console.warn(`Finalized teams invalidated by departure member=${userId}; regenerate teams before starting`);
    }
    console.warn(`Removed departed game member=${userId} (pre-start only)`);
    return true;
  }

  /** Force-fetch every active player: cache alone misses departures during downtime. */
  static async reconcile(guild: Guild, teamCommand: TeamCommand): Promise<string[]> {
    const game = CurrentGameManager.getCurrentGame();
    if (game.getGameStartStatus() !== "idle" || game.isFinished) return [];
    const removed: string[] = [];
    const ids = [...new Set(game.getPlayers().map((p) => p.discordSnowflake))];
    const absent: string[] = [];
    // Verify the entire snapshot before modifying anything: a transient
    // failure on member N must not half-reconcile the first N-1 players.
    for (const id of ids) {
      try {
        if (!(await fetchGuildMember(guild, id))) absent.push(id);
      } catch (error) {
        console.error(`Roster reconciliation aborted guild=${guild.id} member=${id}`, error);
        throw new Error("Cannot verify current guild membership; retry team generation.");
      }
    }
    for (const id of absent) {
      if (await this.handleDeparture(id, teamCommand)) removed.push(id);
    }
    return removed;
  }
}
