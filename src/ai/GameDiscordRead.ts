import { Guild, Message } from "discord.js";
import { ConfigManager } from "../ConfigManager";
import { CurrentGameManager } from "../logic/CurrentGameManager";

export type DiscordDiagnosticFocus = "players" | "polls" | "announcement";
const name = (value: string | null | undefined) =>
  value && /^[A-Za-z0-9_]{3,16}$/.test(value) ? value : "Unknown";

/**
 * Targeted, read-only Discord inspection. No guild-wide member enumeration and
 * no Discord IDs, raw messages, poll answers or user content reach the model.
 */
export async function getGameDiscordDiagnostics(
  guild: Guild,
  focus: DiscordDiagnosticFocus,
  targetIGN?: string
) {
  const game = CurrentGameManager.getCurrentGame();
  const token = game.getLifecycleToken();
  const config = ConfigManager.getConfig();
  if (focus === "players") {
    const targets = (["RED", "BLUE"] as const).flatMap((team) =>
      game.getPlayersOfTeam(team).map((player) => ({ player, team }))
    );
    const selected = targetIGN
      ? targets.filter(({ player }) =>
          [player.latestIGN, player.ignUsed].some(
            (value) => value?.toLowerCase() === targetIGN.toLowerCase()
          )
        )
      : targets;
    if (targetIGN && !selected.length)
      return {
        status: "not_found_in_current_roster",
        source: "process memory",
      };
    const bounded = selected.slice(0, 16);
    const results: Array<{
      ign: string;
      team: "RED" | "BLUE";
      member: string;
      expectedTeamRole: string;
      oppositeTeamRole: string;
      voiceGatewayCache: string;
    }> = [];
    // Four REST member lookups at a time; roles are fresh REST observations.
    for (let i = 0; i < bounded.length; i += 4) {
      const batch = await Promise.all(
        bounded.slice(i, i + 4).map(async ({ player, team }) => {
          const id = player.discordSnowflake;
          const expectedRole =
            team === "RED"
              ? config.roles.redTeamRole
              : config.roles.blueTeamRole;
          const oppositeRole =
            team === "RED"
              ? config.roles.blueTeamRole
              : config.roles.redTeamRole;
          const expectedVC =
            team === "RED"
              ? config.channels.redTeamVC
              : config.channels.blueTeamVC;
          try {
            const member = await guild.members.fetch({
              user: id,
              force: true,
              cache: false,
            });
            const voice = guild.voiceStates.cache.get(id);
            return {
              ign: name(player.latestIGN ?? player.ignUsed),
              team,
              member: "verified present via REST",
              expectedTeamRole: member.roles.cache.has(expectedRole)
                ? "present"
                : "missing",
              oppositeTeamRole: member.roles.cache.has(oppositeRole)
                ? "present (mismatch)"
                : "absent",
              voiceGatewayCache: !voice
                ? "not observed in gateway cache"
                : voice.channelId === expectedVC
                  ? "in expected VC (gateway cache)"
                  : voice.channelId
                    ? "in different VC (gateway cache)"
                    : "not in a VC (gateway cache)",
            };
          } catch {
            return {
              ign: name(player.latestIGN ?? player.ignUsed),
              team,
              member: "unverified (REST lookup failed)",
              expectedTeamRole: "unverified",
              oppositeTeamRole: "unverified",
              voiceGatewayCache: "unverified",
            };
          }
        })
      );
      results.push(...batch);
    }
    if (game.getLifecycleToken() !== token)
      return {
        status: "unverified",
        reason: "Game changed during Discord checks",
      };
    return {
      status: "ok",
      source: "Discord REST for roles, gateway cache for voice",
      checked: results.length,
      totalAssigned: targets.length,
      truncated: selected.length > bounded.length,
      players: results,
      caveat:
        "Role checks are fresh for selected assigned members only. Voice is from gateway cache, not an independent Discord REST audit; missing cache entries are unknown. No scan of unexpected role holders or other channels.",
    };
  }

  const announceChannel = config.channels.announcements;
  const refs: Array<{ label: string; message: Message<boolean> | undefined }> =
    focus === "polls"
      ? [
          { label: "map poll", message: game.mapVoteManager?.pollMessage },
          {
            label: "minerush poll",
            message: game.minerushVoteManager?.pollMessage,
          },
        ]
      : [
          {
            label: "published announcement",
            message: game.announcementMessage,
          },
          { label: "announcement ping", message: game.announcementPingMessage },
        ];
  const checks = [];
  for (const { label, message } of refs) {
    if (!message?.id || message.channelId !== announceChannel) {
      checks.push({
        label,
        delivery: "unverified (no usable in-channel message reference)",
        poll: "unverified",
      });
      continue;
    }
    try {
      // Fetch only the known announcement channel and known message ID.
      const channel = await guild.channels.fetch(announceChannel);
      if (!channel || !("messages" in channel) || !channel.messages) {
        checks.push({
          label,
          delivery: "unavailable (no message access)",
          poll: "unverified",
        });
        continue;
      }
      const fetched = await channel.messages.fetch({
        message: message.id,
        force: true,
      });
      checks.push({
        label,
        delivery: "exists (fresh REST lookup)",
        poll:
          focus === "polls"
            ? fetched.poll
              ? "poll attached; open/closed unverified"
              : "no poll attached"
            : "not applicable",
        ...(fetched.poll?.expiresAt
          ? { configuredPollExpiry: fetched.poll.expiresAt.toISOString() }
          : {}),
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      checks.push({
        label,
        delivery:
          code === 10008
            ? "not found (Discord REST)"
            : "unavailable (Discord REST failed)",
        poll: "unverified",
      });
    }
  }
  if (game.getLifecycleToken() !== token)
    return {
      status: "unverified",
      reason: "Game changed during Discord checks",
    };
  return {
    status: "ok",
    source: "targeted Discord REST message fetch",
    checks,
    caveat:
      "An existing message proves accessibility at observation time, not that a scheduled poll opened on time, accepted votes, closed, or selected a winner. No message reference is not proof of failed delivery.",
  };
}
