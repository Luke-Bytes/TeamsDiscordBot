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

    const token = game.getLifecycleToken();
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
    if (game.getLifecycleToken() !== token || game.getGameStartStatus() !== "idle" ||
        game.isFinished || !game.getPlayers().includes(player)) return false;
    await game.removePlayerByDiscordId(userId);
    if (game.getLifecycleToken() !== token) return true;
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
    const token = game.getLifecycleToken();
    const snapshot = new Set(game.getPlayers());
    const ids = [...new Set([...snapshot].map((p) => p.discordSnowflake))];
    const assertSnapshot = () => {
      const current = game.getPlayers();
      if (game.getLifecycleToken() !== token || game.getGameStartStatus() !== "idle" ||
          game.isFinished || current.length !== snapshot.size ||
          current.some((p) => !snapshot.has(p))) {
        throw new Error("Game or roster changed during membership verification; retry team generation.");
      }
    };
    // Wait for every request in each bounded batch, including failures, before
    // releasing the roster lock. Never mutate until verification completes.
    const verifyAbsent = async (candidates: string[]): Promise<string[]> => {
      const absent: string[] = [];
      for (let start = 0; start < candidates.length; start += 4) {
        const batch = candidates.slice(start, start + 4);
        const results = await Promise.allSettled(batch.map((id) => fetchGuildMember(guild, id)));
        for (const [index, result] of results.entries()) {
          const id = batch[index];
          if (result.status === "rejected") {
            console.error(`Roster reconciliation aborted guild=${guild.id} member=${id}`, result.reason);
            throw new Error("Cannot verify current guild membership; retry team generation.");
          }
          if (!result.value) absent.push(id);
        }
        assertSnapshot();
      }
      assertSnapshot();
      return absent;
    };
    const absent = await verifyAbsent(ids);
    // A player may have rejoined while earlier parallel requests were pending.
    // Recheck only absent candidates, before applying ANY removal.
    const confirmedAbsent = await verifyAbsent(absent);
    for (const id of confirmedAbsent) {
      assertSnapshot();
      if (await this.handleDeparture(id, teamCommand)) {
        removed.push(id);
        for (const player of snapshot) {
          if (player.discordSnowflake === id) snapshot.delete(player);
        }
      }
      assertSnapshot();
    }
    return removed;
  }
}
