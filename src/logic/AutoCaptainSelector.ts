import { Guild, GuildMember } from "discord.js";
import { CurrentGameManager } from "./CurrentGameManager";
import { PlayerInstance } from "../database/PlayerInstance";
import { PermissionsUtil } from "../util/PermissionsUtil";
import TeamCommand from "../commands/TeamCommand";
import { fetchGuildMember } from "../util/DiscordFailures";

type SelectionResult =
  | { blue: PlayerInstance; red: PlayerInstance }
  | { error: string };

export class AutoCaptainSelector {
  private static readonly allowedStatuses = new Set(["online", "idle", "dnd"]);
  private static readonly eligibilityError =
    "Could not find enough eligible players for captains. Organisers, please set captains manually.";

  public static async randomiseCaptains(
    guild: Guild,
    autoStartDraft = false
  ): Promise<SelectionResult> {
    const game = CurrentGameManager.getCurrentGame();
    if (!game.announced || game.getGameStartStatus() !== "idle" || game.isFinished) {
      return { error: "Captains cannot be selected after the game has started or ended." };
    }
    if (TeamCommand.instance?.isTeamPickingSessionActive()) {
      return { error: "Captains cannot be changed while team picking is in progress." };
    }

    const token = game.getLifecycleToken();
    try {
      const teamsDecided = !!game.teamsDecidedBy;
      const selection = teamsDecided
        ? await this.selectEligibleCaptainsFromTeams(guild)
        : await this.selectEligibleCaptains(guild, game.getPlayers());

      if ("error" in selection) return selection;
      if (game.getLifecycleToken() !== token || game.getGameStartStatus() !== "idle") {
        return { error: "Game changed during captain eligibility lookup; no captains were selected." };
      }
      const { first, second } = selection;
      const roles = PermissionsUtil.config.roles;
      // Resolve every affected member before the first external role operation.
      // A 10007 means the person cannot be selected; other lookup failures
      // are uncertain and must abort without changing the game roster.
      const firstMember = await fetchGuildMember(guild, first.discordSnowflake);
      const secondMember = await fetchGuildMember(guild, second.discordSnowflake);
      if (!firstMember || !secondMember) {
        return { error: "A selected captain is no longer in the server. No captains were changed." };
      }

      const previousBlue = game.getCaptainOfTeam("BLUE");
      const previousRed = game.getCaptainOfTeam("RED");
      const replaced = [previousBlue, previousRed].filter(
        (p): p is PlayerInstance =>
          !!p && p.discordSnowflake !== first.discordSnowflake &&
          p.discordSnowflake !== second.discordSnowflake
      );
      const oldMembers: GuildMember[] = [];
      for (const player of replaced) {
        const member = await fetchGuildMember(guild, player.discordSnowflake);
        if (member) oldMembers.push(member);
      }

      if (game.getLifecycleToken() !== token || game.getGameStartStatus() !== "idle") {
        return { error: "Game changed during captain member verification; no captains were selected." };
      }
      // Roles are a recoverable external projection. If any operation fails,
      // never commit a new authoritative captain; report possible partial roles.
      for (const [member, team] of [
        [firstMember, "BLUE"],
        [secondMember, "RED"],
      ] as const) {
        await member.roles.add(roles.captainRole);
        await member.roles.add(team === "BLUE" ? roles.blueTeamRole : roles.redTeamRole);
        await member.roles.remove(team === "BLUE" ? roles.redTeamRole : roles.blueTeamRole);
      }
      for (const member of oldMembers) {
        await member.roles.remove(roles.captainRole);
        if (!teamsDecided) {
          await member.roles.remove(roles.blueTeamRole);
          await member.roles.remove(roles.redTeamRole);
        }
      }

      if (game.getLifecycleToken() !== token || game.getGameStartStatus() !== "idle") {
        return { error: "Game changed while assigning Discord roles. No captain change was committed; inspect partial roles." };
      }
      if (teamsDecided) {
        if (previousBlue) previousBlue.captain = false;
        if (previousRed) previousRed.captain = false;
        first.captain = true;
        second.captain = true;
      } else {
        game.setTeamCaptain("BLUE", first);
        game.setTeamCaptain("RED", second);
      }

      if (autoStartDraft) {
        await CurrentGameManager.attemptAutoStartDraft(guild);
      }

      return { blue: first, red: second };
    } catch (error) {
      console.error("Automatic captain assignment failed; captain state was not committed", error);
      return {
        error: "Cannot verify or assign captains with Discord right now. No captain change was committed; check for partial role changes before retrying.",
      };
    }
  }

  private static async eligiblePlayers(
    guild: Guild,
    players: PlayerInstance[]
  ): Promise<{ p: PlayerInstance; elo: number }[]> {
    const eligible: { p: PlayerInstance; elo: number }[] = [];
    for (const p of players) {
      const elo = Number(p.elo ?? 0);
      if (elo <= 1000) continue;
      const member = await fetchGuildMember(guild, p.discordSnowflake);
      if (!member) continue;
      const status = member.presence?.status;
      // Preserve the existing rule: a missing presence is not offline.
      if (status && !this.allowedStatuses.has(status)) continue;
      eligible.push({ p, elo });
    }
    return eligible;
  }

  private static async selectEligibleCaptains(
    guild: Guild,
    players: PlayerInstance[]
  ): Promise<{ first: PlayerInstance; second: PlayerInstance } | { error: string }> {
    const eligible = await this.eligiblePlayers(guild, players);
    if (eligible.length < 2) return { error: this.eligibilityError };

    const first = eligible[Math.floor(Math.random() * eligible.length)];
    const rest = eligible.filter((e) => e.p !== first.p);
    const higher = rest
      .filter((e) => e.elo >= first.elo)
      .sort((a, b) => a.elo - b.elo);
    const second =
      higher[0] ||
      rest.sort(
        (a, b) => Math.abs(a.elo - first.elo) - Math.abs(b.elo - first.elo)
      )[0];
    if (!second) return { error: this.eligibilityError };
    return { first: first.p, second: second.p };
  }

  private static async selectEligibleCaptainsFromTeams(
    guild: Guild
  ): Promise<{ first: PlayerInstance; second: PlayerInstance } | { error: string }> {
    const game = CurrentGameManager.getCurrentGame();
    const blue = await this.eligiblePlayers(guild, game.getPlayersOfTeam("BLUE"));
    const red = await this.eligiblePlayers(guild, game.getPlayersOfTeam("RED"));
    if (!blue.length || !red.length) return { error: this.eligibilityError };
    return {
      first: blue[Math.floor(Math.random() * blue.length)].p,
      second: red[Math.floor(Math.random() * red.length)].p,
    };
  }
}
