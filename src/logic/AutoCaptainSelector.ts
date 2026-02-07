import { Guild, GuildMember } from "discord.js";
import { CurrentGameManager } from "./CurrentGameManager";
import { PlayerInstance } from "../database/PlayerInstance";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { DraftTeamPickingSession } from "./teams/DraftTeamPickingSession";
import TeamCommand from "../commands/TeamCommand";

type SelectionResult =
  | { blue: PlayerInstance; red: PlayerInstance }
  | { error: string };

export class AutoCaptainSelector {
  private static readonly allowedStatuses = new Set(["online", "idle", "dnd"]);

  public static async randomiseCaptains(
    guild: Guild,
    autoStartDraft = false
  ): Promise<SelectionResult> {
    const game = CurrentGameManager.getCurrentGame();
    const selection = await this.selectEligibleCaptains(
      guild,
      game.getPlayers()
    );

    if ("error" in selection) {
      return selection;
    }

    const { first, second } = selection;

    await this.assignCaptain(guild, "BLUE", first);
    await this.assignCaptain(guild, "RED", second);

    if (autoStartDraft) {
      try {
        const fakeInteraction = {
          editReply: async (_: unknown) => {},
          guild,
        } as unknown as import("discord.js").ChatInputCommandInteraction;
        const session = new DraftTeamPickingSession();
        await session.initialize(fakeInteraction);
        if (TeamCommand.instance) {
          TeamCommand.instance.teamPickingSession = session;
        }
      } catch (e) {
        console.error("Failed to auto-start draft team picking:", e);
      }
    }

    const gameInstance = CurrentGameManager.getCurrentGame();
    return {
      blue: gameInstance.getCaptainOfTeam("BLUE")!,
      red: gameInstance.getCaptainOfTeam("RED")!,
    };
  }

  private static async selectEligibleCaptains(
    guild: Guild,
    players: PlayerInstance[]
  ): Promise<
    { first: PlayerInstance; second: PlayerInstance } | { error: string }
  > {
    const eligible: { p: PlayerInstance; elo: number }[] = [];

    for (const p of players) {
      const elo = Number(p.elo ?? 0);
      if (elo <= 1000) continue;

      const member: GuildMember | null = await guild.members
        .fetch(p.discordSnowflake)
        .catch(() => null);
      const status = member?.presence?.status ?? undefined;

      if (status && !this.allowedStatuses.has(status)) continue;

      eligible.push({ p, elo });
    }

    if (eligible.length < 2) {
      return {
        error:
          "Could not find enough eligible players for captains. Organisers, please set captains manually.",
      };
    }

    const first = eligible[Math.floor(Math.random() * eligible.length)];
    const rest = eligible.filter((e) => e.p !== first.p);
    let higher = rest
      .filter((e) => e.elo >= first.elo)
      .sort((a, b) => a.elo - b.elo);
    let second =
      higher[0] ||
      rest.sort(
        (a, b) => Math.abs(a.elo - first.elo) - Math.abs(b.elo - first.elo)
      )[0];

    if (!second) {
      return {
        error:
          "Could not find enough eligible players for captains. Organisers, please set captains manually.",
      };
    }

    return { first: first.p, second: second.p };
  }

  private static async assignCaptain(
    guild: Guild,
    team: "RED" | "BLUE",
    player: PlayerInstance
  ): Promise<void> {
    const game = CurrentGameManager.getCurrentGame();
    const res = game.setTeamCaptain(team, player);

    if (res.oldCaptain) {
      await guild.members
        .fetch(res.oldCaptain)
        .then(async (oldM) => {
          const roles = PermissionsUtil.config.roles;
          const roleIds = [
            roles.captainRole,
            roles.redTeamRole,
            roles.blueTeamRole,
          ].filter(Boolean);
          await Promise.allSettled(roleIds.map((id) => oldM.roles.remove(id)));
        })
        .catch(() => undefined);
    }

    await guild.members
      .fetch(player.discordSnowflake)
      .then(async (m) => {
        await m.roles.add(PermissionsUtil.config.roles.captainRole);
        if (team === "RED") {
          await m.roles.add(PermissionsUtil.config.roles.redTeamRole);
          await m.roles.remove(PermissionsUtil.config.roles.blueTeamRole);
        } else {
          await m.roles.add(PermissionsUtil.config.roles.blueTeamRole);
          await m.roles.remove(PermissionsUtil.config.roles.redTeamRole);
        }
      })
      .catch(() => undefined);
  }
}
