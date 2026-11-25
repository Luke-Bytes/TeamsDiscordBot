import {
  ChannelType,
  Guild,
  GuildBasedChannel,
  GuildMember,
  PermissionFlagsBits,
  OverwriteType,
  Role,
} from "discord.js";
import { Config, ConfigManager } from "../ConfigManager";

export type PreflightIssue = {
  severity: "error" | "warning";
  location: string;
  detail: string;
};

export type GameChannelPreflightReport = {
  checked: number;
  issues: PreflightIssue[];
  ok: boolean;
};

type ChannelRule = {
  key: keyof Config["channels"];
  label: string;
  kind: "text" | "voice" | "category";
  team?: "red" | "blue";
  optional?: boolean;
};

const CHANNELS: ChannelRule[] = [
  { key: "announcements", label: "Announcements", kind: "text" },
  { key: "registration", label: "Registration", kind: "text" },
  { key: "gameFeed", label: "Game feed", kind: "text" },
  { key: "botCommands", label: "Bot commands", kind: "text" },
  { key: "teamPickingChat", label: "Team picking chat", kind: "text" },
  { key: "teamPickingVC", label: "Team picking voice", kind: "voice" },
  { key: "redTeamChat", label: "Red team chat", kind: "text", team: "red" },
  { key: "blueTeamChat", label: "Blue team chat", kind: "text", team: "blue" },
  { key: "redTeamVC", label: "Red team voice", kind: "voice", team: "red" },
  { key: "blueTeamVC", label: "Blue team voice", kind: "voice", team: "blue" },
  {
    key: "eventSignUps",
    label: "Event sign-ups",
    kind: "text",
    optional: true,
  },
  {
    key: "temporaryVoiceCategory",
    label: "Temporary voice category",
    kind: "category",
    optional: true,
  },
];

function can(
  channel: GuildBasedChannel,
  subject: Role | GuildMember,
  permission: bigint
): boolean | null {
  if (!("permissionsFor" in channel)) return null;
  const permissions = channel.permissionsFor(subject);
  return permissions ? permissions.has(permission) : null;
}

export class GameChannelPreflight {
  /** Read-only: fetch current Discord permissions, never update channels or roles. */
  static async run(guild: Guild): Promise<GameChannelPreflightReport> {
    const config = ConfigManager.getConfig();
    const issues: PreflightIssue[] = [];
    let checked = 0;
    const add = (
      severity: PreflightIssue["severity"],
      location: string,
      detail: string
    ) => issues.push({ severity, location, detail });

    const roles: Partial<Record<"red" | "blue", Role>> = {};
    for (const team of ["red", "blue"] as const) {
      const id = config.roles[team === "red" ? "redTeamRole" : "blueTeamRole"];
      if (!id) {
        add("error", `${team} team role`, "No role ID is configured.");
        continue;
      }
      try {
        const role = await guild.roles.fetch(id, { force: true });
        if (!role || role.guild.id !== guild.id) {
          add(
            "error",
            `${team} team role`,
            "Configured role not found in this server."
          );
        } else {
          roles[team] = role;
          if (role.permissions.has(PermissionFlagsBits.Administrator)) {
            add(
              "error",
              `${team} team role`,
              "Team role has Administrator, which bypasses private-channel restrictions."
            );
          }
        }
      } catch {
        add(
          "error",
          `${team} team role`,
          "Could not verify the role in Discord."
        );
      }
    }
    if (
      config.roles.redTeamRole &&
      config.roles.redTeamRole === config.roles.blueTeamRole
    ) {
      add(
        "error",
        "Team roles",
        "Red and blue use the same role; channels cannot be isolated."
      );
    }

    let notifyRole: Role | null = null;
    const notifyId = config.roles.gameNotify;
    if (!notifyId) {
      add(
        "warning",
        "Game Notify role",
        "No notification role is configured; announcement pings will be skipped."
      );
    } else {
      if (
        [
          config.roles.redTeamRole,
          config.roles.blueTeamRole,
          config.roles.organiserRole,
          guild.id,
        ].includes(notifyId)
      ) {
        add(
          "error",
          "Game Notify role",
          "Notification role must be separate from both team roles, the organiser role and @everyone."
        );
      }
      try {
        notifyRole = await guild.roles.fetch(notifyId, { force: true });
        if (!notifyRole || notifyRole.guild.id !== guild.id) {
          add(
            "error",
            "Game Notify role",
            "Configured notification role not found in this server."
          );
          notifyRole = null;
        } else if (
          notifyRole.permissions.has(PermissionFlagsBits.Administrator)
        ) {
          add(
            "error",
            "Game Notify role",
            "Notification role has Administrator and can bypass private team channels."
          );
        }
      } catch {
        add(
          "error",
          "Game Notify role",
          "Could not verify the notification role in Discord."
        );
      }
    }

    let bot: GuildMember | null = null;
    try {
      bot = guild.members.me ?? (await guild.members.fetchMe());
    } catch {
      add("error", "Bot", "Could not check the bot's channel permissions.");
    }

    const seen = new Map<string, string>();
    for (const rule of CHANNELS) {
      const id = config.channels[rule.key];
      if (!id) {
        if (!rule.optional)
          add("error", rule.label, "No channel ID is configured.");
        continue;
      }
      const previous = seen.get(id);
      if (previous) {
        add(
          "error",
          rule.label,
          `Shares a channel with ${previous}; configured destinations must be distinct.`
        );
        continue;
      }
      seen.set(id, rule.label);

      let channel: GuildBasedChannel | null = null;
      try {
        channel = await guild.channels.fetch(id, { force: true });
      } catch {
        add(
          "error",
          rule.label,
          "Could not fetch the configured channel from Discord."
        );
        continue;
      }
      if (!channel || channel.guildId !== guild.id) {
        add(
          "error",
          rule.label,
          "Configured channel not found in this server."
        );
        continue;
      }
      const expected =
        rule.kind === "category"
          ? channel.type === ChannelType.GuildCategory
          : rule.kind === "voice"
            ? channel.type === ChannelType.GuildVoice
            : channel.type === ChannelType.GuildText ||
              channel.type === ChannelType.GuildAnnouncement;
      if (!expected) {
        add(
          "error",
          rule.label,
          `Expected a ${rule.kind} channel, got a different channel type.`
        );
        continue;
      }
      checked += 1;

      const publicView = can(
        channel,
        guild.roles.everyone,
        PermissionFlagsBits.ViewChannel
      );
      if (publicView === null) {
        add(
          "error",
          rule.label,
          "Could not calculate effective channel permissions."
        );
        continue;
      }

      if (rule.team) {
        const own = roles[rule.team];
        const other = roles[rule.team === "red" ? "blue" : "red"];
        if (publicView) {
          add(
            "error",
            rule.label,
            "@everyone can view this team channel. Deny View Channel to @everyone."
          );
        }
        if (
          own &&
          can(channel, own, PermissionFlagsBits.ViewChannel) !== true
        ) {
          add(
            "error",
            rule.label,
            `The ${rule.team} role cannot view its own channel. Allow View Channel.`
          );
        }
        if (
          rule.kind === "text" &&
          own &&
          can(channel, own, PermissionFlagsBits.SendMessages) !== true
        ) {
          add(
            "error",
            rule.label,
            `The ${rule.team} role cannot send messages in its team chat.`
          );
        }
        if (
          other &&
          can(channel, other, PermissionFlagsBits.ViewChannel) !== false
        ) {
          add(
            "error",
            rule.label,
            "The opposing team role can view this channel (or access could not be verified)."
          );
        }
        if (
          notifyRole &&
          can(channel, notifyRole, PermissionFlagsBits.ViewChannel) !== false
        ) {
          add(
            "error",
            rule.label,
            "Game Notify role can view this private team channel (or access could not be verified). Remove its access."
          );
        }
        if (
          rule.kind === "voice" &&
          notifyRole &&
          can(channel, notifyRole, PermissionFlagsBits.Connect) !== false
        ) {
          add(
            "error",
            rule.label,
            "Game Notify role can connect to this private team voice channel (or access could not be verified)."
          );
        }

        if (rule.kind === "voice") {
          for (const [subject, label, mustConnect] of [
            [guild.roles.everyone, "@everyone", false],
            [own, `${rule.team} role`, true],
            [other, "Opposing role", false],
          ] as const) {
            if (!subject) continue;
            const allowed = can(channel, subject, PermissionFlagsBits.Connect);
            if (allowed === null || allowed !== mustConnect) {
              add(
                "error",
                rule.label,
                `${label} ${mustConnect ? "cannot connect" : "can connect"} to this team's voice channel.`
              );
            }
          }
        }

        // Other role overwrites can override a deny on the rival team. Member
        // overwrites can similarly let individuals bypass team isolation.
        if ("permissionOverwrites" in channel) {
          for (const overwrite of channel.permissionOverwrites.cache.values()) {
            if (overwrite.id === guild.id || overwrite.id === own?.id) continue;
            const extraView = overwrite.allow.has(
              PermissionFlagsBits.ViewChannel
            );
            const extraConnect =
              rule.kind === "voice" &&
              overwrite.allow.has(PermissionFlagsBits.Connect);
            if (!extraView && !extraConnect) continue;
            const trustedOrganiser =
              overwrite.type === OverwriteType.Role &&
              overwrite.id === config.roles.organiserRole;
            const botRole = bot?.roles.cache.get(overwrite.id);
            const trustedBotRole =
              overwrite.type === OverwriteType.Role &&
              botRole?.managed === true &&
              botRole.tags?.botId === bot?.id;
            if (trustedOrganiser || trustedBotRole) continue;
            add(
              "error",
              rule.label,
              `Extra ${overwrite.type === OverwriteType.Member ? "member" : "role"} overwrite ${overwrite.id} allows ${extraView ? "View Channel" : "Connect"}; it may bypass team isolation.`
            );
          }
        }
      } else if (
        rule.kind !== "category" &&
        [
          "announcements",
          "registration",
          "gameFeed",
          "botCommands",
          "teamPickingChat",
          "teamPickingVC",
          "eventSignUps",
        ].includes(rule.key) &&
        !publicView
      ) {
        add(
          "warning",
          rule.label,
          "@everyone cannot view this common channel; check that players can access it."
        );
      }

      if (bot) {
        const required =
          rule.kind === "category"
            ? [PermissionFlagsBits.ManageChannels]
            : rule.kind === "text"
              ? [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                ]
              : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect];
        for (const permission of required) {
          if (can(channel, bot, permission) !== true) {
            add(
              rule.optional ? "warning" : "error",
              rule.label,
              `The bot lacks ${permission === PermissionFlagsBits.ViewChannel ? "View Channel" : permission === PermissionFlagsBits.SendMessages ? "Send Messages" : permission === PermissionFlagsBits.ManageChannels ? "Manage Channels" : "Connect"} permission.`
            );
          }
        }
        if (
          rule.key === "announcements" &&
          notifyRole &&
          !notifyRole.mentionable &&
          can(channel, bot, PermissionFlagsBits.MentionEveryone) !== true
        ) {
          add(
            "warning",
            rule.label,
            "Game Notify role is not mentionable and the bot lacks Mention Everyone; the announcement ping may fail."
          );
        }
        if (
          ["announcements", "gameFeed"].includes(rule.key) &&
          can(channel, bot, PermissionFlagsBits.EmbedLinks) !== true
        ) {
          add(
            "error",
            rule.label,
            "The bot lacks Embed Links permission for match updates."
          );
        }
        if (
          rule.key === "gameFeed" &&
          can(channel, bot, PermissionFlagsBits.ManageMessages) !== true
        ) {
          add(
            "warning",
            rule.label,
            "The bot lacks Manage Messages for clearing old game-feed posts."
          );
        }
        if (
          rule.kind === "voice" &&
          can(channel, bot, PermissionFlagsBits.MoveMembers) !== true
        ) {
          add(
            "error",
            rule.label,
            "The bot lacks Move Members; automatic voice moves may fail."
          );
        }
      }
    }

    // A member carrying both team roles can see both teams even when the
    // single-role checks above pass. This is based on cached members only.
    const both = guild.members.cache.filter(
      (member) =>
        member.roles.cache.has(config.roles.redTeamRole) &&
        member.roles.cache.has(config.roles.blueTeamRole)
    );
    if (both.size) {
      add(
        "error",
        "Team roles",
        `${both.size} cached member(s) carry both team roles and may see both teams; fix role cleanup.`
      );
    }

    return {
      checked,
      issues,
      ok: !issues.some((issue) => issue.severity === "error"),
    };
  }
}

export function formatGameChannelPreflight(
  report: GameChannelPreflightReport
): string {
  const errors = report.issues.filter((issue) => issue.severity === "error");
  const warnings = report.issues.filter(
    (issue) => issue.severity === "warning"
  );
  const heading = report.ok
    ? `✅ Pre-flight passed: ${report.checked} game channels checked.`
    : `⚠️ Pre-flight found ${errors.length} permission/setup issue(s) and ${warnings.length} warning(s) across ${report.checked} checked channels. Review and fix these; the audit does not block announcements.`;
  const lines = [
    heading,
    ...errors.map((issue) => `🔴 **${issue.location}:** ${issue.detail}`),
    ...warnings.map((issue) => `⚠️ **${issue.location}:** ${issue.detail}`),
  ];
  let message = "";
  for (const [index, line] of lines.entries()) {
    if (message.length + line.length + 1 > 1750) {
      message += `\n…and ${lines.length - index} more issue(s). Run /announce check after fixing the above.`;
      break;
    }
    message += (message ? "\n" : "") + line;
  }
  return (
    message +
    (report.ok
      ? "\nNote: server administrators and members with multiple roles can bypass role-only visibility checks; review any intentional exceptions."
      : "\nPlease check/fix the permissions and re-run /announce check. This audit is advisory only.")
  );
}
