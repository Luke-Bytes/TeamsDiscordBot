import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits as P,
} from "discord.js";
import AnnouncementCommand from "../../src/commands/AnnouncementCommand";
import { ConfigManager, Config } from "../../src/ConfigManager";
import { GameInstance } from "../../src/database/GameInstance";
import {
  GameChannelPreflight,
  formatGameChannelPreflight,
} from "../../src/util/GameChannelPreflight";
import { assert, assertEqual } from "../framework/assert";
import { test } from "../framework/test";

type FakePreflightChannel = {
  id: string;
  guildId: string;
  type: ChannelType;
  grants: Map<string, Set<bigint>>;
  permissionOverwrites: { cache: Map<string, any> };
  permissionsFor: (subject: { id: string }) => {
    has: (permission: bigint) => boolean;
  };
};

function makeFixture() {
  const base = ConfigManager.getConfig();
  const originalGetConfig = ConfigManager.getConfig;
  const channelKeys = [
    "announcements",
    "registration",
    "gameFeed",
    "botCommands",
    "teamPickingChat",
    "teamPickingVC",
    "redTeamChat",
    "blueTeamChat",
    "redTeamVC",
    "blueTeamVC",
    "eventSignUps",
    "temporaryVoiceCategory",
  ] as const;
  const roles = {
    ...base.roles,
    redTeamRole: "preflight-red",
    blueTeamRole: "preflight-blue",
    organiserRole: "preflight-organiser",
    gameNotify: "preflight-game-notify",
  };
  const channels = { ...base.channels };
  for (const key of channelKeys) channels[key] = `preflight-${key}`;
  ConfigManager.getConfig = () => ({ ...base, roles, channels }) as Config;

  const guildId = "preflight-guild";
  const everyone = { id: guildId };
  const red = {
    id: roles.redTeamRole,
    guild: { id: guildId },
    permissions: { has: () => false },
  };
  const blue = {
    id: roles.blueTeamRole,
    guild: { id: guildId },
    permissions: { has: () => false },
  };
  const notify = {
    id: roles.gameNotify,
    guild: { id: guildId },
    mentionable: true,
    permissions: { has: () => false },
  };
  const organiser = {
    id: "organiser-user",
    roles: {
      cache: new Map([
        [roles.organiserRole, true],
        [base.roles.organiserRole, true],
      ]),
    },
  };
  const bot = { id: "bot", roles: { cache: new Map() } };
  const channelMap = new Map<string, FakePreflightChannel>();
  for (const key of channelKeys) {
    const isVoice = key.endsWith("VC");
    const isCategory = key === "temporaryVoiceCategory";
    const team = key.startsWith("redTeam")
      ? red.id
      : key.startsWith("blueTeam")
        ? blue.id
        : null;
    const grants = new Map<string, Set<bigint>>();
    const view = P.ViewChannel;
    const connect = P.Connect;
    grants.set(guildId, new Set(team ? [] : [view, P.SendMessages, connect]));
    grants.set(
      red.id,
      new Set(team === red.id ? [view, P.SendMessages, connect] : [])
    );
    grants.set(
      blue.id,
      new Set(team === blue.id ? [view, P.SendMessages, connect] : [])
    );
    grants.set(notify.id, new Set(team ? [] : [view]));
    grants.set(
      bot.id,
      new Set([
        view,
        P.SendMessages,
        P.EmbedLinks,
        connect,
        P.MoveMembers,
        P.ManageMessages,
        P.ManageChannels,
      ])
    );
    const fake: FakePreflightChannel = {
      id: channels[key]!,
      guildId,
      type: isCategory
        ? ChannelType.GuildCategory
        : isVoice
          ? ChannelType.GuildVoice
          : ChannelType.GuildText,
      grants,
      permissionOverwrites: { cache: new Map() },
      permissionsFor(subject) {
        return {
          has: (permission) => Boolean(grants.get(subject.id)?.has(permission)),
        };
      },
    };
    channelMap.set(key, fake);
  }

  const members = new Map([[organiser.id, organiser]]);
  const guild: any = {
    id: guildId,
    roles: {
      everyone,
      fetch: async (id: string) =>
        id === red.id
          ? red
          : id === blue.id
            ? blue
            : id === notify.id
              ? notify
              : null,
    },
    members: {
      me: bot,
      cache: {
        get: (id: string) => members.get(id),
        filter: () => ({ size: 0 }),
      },
    },
    channels: {
      fetch: async (id: string) =>
        channelMap.size
          ? ([...channelMap.values()].find((ch) => ch.id === id) ?? null)
          : null,
    },
  };
  return {
    guild,
    roles,
    channels: channelMap,
    restore: () => {
      ConfigManager.getConfig = originalGetConfig;
    },
  };
}

test("Game channel pre-flight passes when team roles are isolated and bot can operate", async () => {
  const fixture = makeFixture();
  try {
    fixture.guild.members.me.roles.cache.set("bot-managed-role", {
      managed: true,
      tags: { botId: "bot" },
    });
    fixture.channels
      .get("blueTeamChat")!
      .permissionOverwrites.cache.set("bot-managed-role", {
        id: "bot-managed-role",
        type: OverwriteType.Role,
        allow: { has: (permission: bigint) => permission === P.ViewChannel },
      });
    const report = await GameChannelPreflight.run(fixture.guild);
    assert(report.ok, formatGameChannelPreflight(report));
    assertEqual(
      report.checked,
      12,
      "Checks game channels plus configured optional channels"
    );
    assertEqual(report.issues.length, 0, "No errors or warnings");
  } finally {
    fixture.restore();
  }
});

test("Game channel pre-flight flags public, cross-team and extra overwrite access", async () => {
  const fixture = makeFixture();
  try {
    fixture.channels
      .get("blueTeamChat")!
      .grants.get(fixture.guild.id)!
      .add(P.ViewChannel);
    fixture.channels
      .get("redTeamChat")!
      .grants.get(fixture.roles.blueTeamRole)!
      .add(P.ViewChannel);
    const redVC = fixture.channels.get("redTeamVC")!;
    redVC.permissionOverwrites.cache.set("spectator-role", {
      id: "spectator-role",
      type: OverwriteType.Role,
      allow: { has: (permission: bigint) => permission === P.Connect },
    });
    fixture.guild.members.cache.filter = () => ({ size: 1 });
    const report = await GameChannelPreflight.run(fixture.guild);
    assert(!report.ok, "Privacy leaks must be reported as serious issues");
    const summary = formatGameChannelPreflight(report);
    assert(
      summary.includes("audit does not block announcements") &&
        !summary.includes("Announcement not sent"),
      "The report must clearly state that the audit is advisory"
    );
    assert(
      report.issues.some((issue) => issue.location === "Team roles"),
      "A member carrying both team roles is a blocking access leak"
    );
    assert(
      report.issues.some(
        (i) => i.location === "Blue team chat" && i.detail.includes("@everyone")
      ),
      "Public blue channel flagged"
    );
    assert(
      report.issues.some(
        (i) => i.location === "Red team chat" && i.detail.includes("opposing")
      ),
      "Cross-team visibility flagged"
    );
    assert(
      report.issues.some(
        (i) =>
          i.location === "Red team voice" && i.detail.includes("spectator-role")
      ),
      "Extra Connect overwrite flagged"
    );
  } finally {
    fixture.restore();
  }
});

test("Game Notify role cannot see either team chat or enter private team voice", async () => {
  const fixture = makeFixture();
  try {
    const redChat = fixture.channels.get("redTeamChat")!;
    const blueChat = fixture.channels.get("blueTeamChat")!;
    const redVoice = fixture.channels.get("redTeamVC")!;
    const blueVoice = fixture.channels.get("blueTeamVC")!;

    // A separate notification role must not inherit access from any role
    // overwrite, even though @everyone is correctly denied.
    redChat.grants.get(fixture.roles.gameNotify)!.add(P.ViewChannel);
    blueChat.grants.get(fixture.roles.gameNotify)!.add(P.ViewChannel);
    redVoice.grants.get(fixture.roles.gameNotify)!.add(P.ViewChannel);
    blueVoice.grants.get(fixture.roles.gameNotify)!.add(P.Connect);

    const report = await GameChannelPreflight.run(fixture.guild);
    assert(!report.ok, "Notification-role privacy leaks block announcements");
    for (const location of [
      "Red team chat",
      "Blue team chat",
      "Red team voice",
      "Blue team voice",
    ]) {
      assert(
        report.issues.some(
          (issue) =>
            issue.location === location &&
            issue.detail.includes("Game Notify role")
        ),
        `Notification-role access flagged for ${location}`
      );
    }
    assert(
      report.issues.some(
        (issue) =>
          issue.location === "Blue team voice" &&
          issue.detail.includes("connect")
      ),
      "Notification-role voice connection flagged separately"
    );
  } finally {
    fixture.restore();
  }
});

test("Game Notify role must exist and cannot be a team role or administrator", async () => {
  const fixture = makeFixture();
  try {
    const originalFetch = fixture.guild.roles.fetch;
    fixture.guild.roles.fetch = async (id: string) =>
      id === fixture.roles.gameNotify ? null : originalFetch(id);
    const missing = await GameChannelPreflight.run(fixture.guild);
    assert(!missing.ok, "Missing configured notification role is blocking");
    assert(
      missing.issues.some(
        (issue) =>
          issue.location === "Game Notify role" &&
          issue.detail.includes("not found")
      ),
      "Missing role diagnosed"
    );
    fixture.guild.roles.fetch = originalFetch;

    const notify = await originalFetch(fixture.roles.gameNotify);
    notify.permissions.has = (permission: bigint) =>
      permission === P.Administrator;
    const elevated = await GameChannelPreflight.run(fixture.guild);
    assert(
      !elevated.ok,
      "Administrator notification role must fail privacy check"
    );
    assert(
      elevated.issues.some(
        (issue) =>
          issue.location === "Game Notify role" &&
          issue.detail.includes("Administrator")
      ),
      "Administrator leak diagnosed"
    );
  } finally {
    fixture.restore();
  }
});

test("Game Notify ping readiness is reported without blocking an otherwise private match", async () => {
  const fixture = makeFixture();
  try {
    const notify = await fixture.guild.roles.fetch(fixture.roles.gameNotify);
    notify.mentionable = false;
    const report = await GameChannelPreflight.run(fixture.guild);
    assert(report.ok, "Ping configuration should be advisory");
    assert(
      report.issues.some(
        (issue) =>
          issue.severity === "warning" &&
          issue.location === "Announcements" &&
          issue.detail.includes("not mentionable")
      ),
      "The bot reports why an announcement ping may not reach members"
    );
  } finally {
    fixture.restore();
  }
});

test("Optional event sign-ups and temporary voice category are checked when configured", async () => {
  const fixture = makeFixture();
  try {
    const signup = fixture.channels.get("eventSignUps")!;
    const category = fixture.channels.get("temporaryVoiceCategory")!;
    signup.grants.get("bot")!.delete(P.SendMessages);
    category.grants.get("bot")!.delete(P.ManageChannels);
    let report = await GameChannelPreflight.run(fixture.guild);
    assert(report.ok, "Non-game optional channel bot issues are warnings");
    assertEqual(report.checked, 12, "Both extra channels included");
    assert(
      report.issues.some(
        (issue) =>
          issue.location === "Event sign-ups" &&
          issue.severity === "warning" &&
          issue.detail.includes("Send Messages")
      ),
      "Event sign-up delivery warning provided"
    );
    assert(
      report.issues.some(
        (issue) =>
          issue.location === "Temporary voice category" &&
          issue.severity === "warning" &&
          issue.detail.includes("Manage Channels")
      ),
      "Temporary voice category warning provided"
    );

    category.type = ChannelType.GuildText;
    const wrongType = await GameChannelPreflight.run(fixture.guild);
    assert(
      wrongType.issues.some(
        (issue) =>
          issue.location === "Temporary voice category" &&
          issue.detail.includes("Expected a category")
      ),
      "Incorrectly configured optional category type is diagnosed"
    );
    category.type = ChannelType.GuildCategory;

    const channels = ConfigManager.getConfig().channels;
    channels.eventSignUps = "";
    channels.temporaryVoiceCategory = "";
    report = await GameChannelPreflight.run(fixture.guild);
    assert(report.ok, "Disabled optional channel features don't block a match");
    assertEqual(
      report.checked,
      10,
      "Only core game channels checked when optional IDs are blank"
    );
  } finally {
    fixture.restore();
  }
});

test("Game channel pre-flight reports missing channels, role failures, and bot permissions", async () => {
  const fixture = makeFixture();
  try {
    fixture.guild.roles.fetch = async (id: string) =>
      id === fixture.roles.redTeamRole
        ? null
        : {
            id,
            guild: { id: fixture.guild.id },
            permissions: { has: () => false },
          };
    fixture.channels
      .get("announcements")!
      .grants.get("bot")!
      .delete(P.EmbedLinks);
    fixture.channels
      .get("blueTeamChat")!
      .grants.get(fixture.roles.blueTeamRole)!
      .delete(P.SendMessages);
    fixture.channels
      .get("teamPickingVC")!
      .grants.get("bot")!
      .delete(P.MoveMembers);
    fixture.channels.delete("registration");
    const report = await GameChannelPreflight.run(fixture.guild);
    assert(!report.ok, "Misconfiguration must be flagged");
    const summary = formatGameChannelPreflight(report);
    assert(summary.includes("red team role"), "Missing team role listed");
    assert(summary.includes("Registration"), "Missing channel listed");
    assert(summary.includes("Embed Links"), "Bot embed access listed");
    assert(
      summary.includes("Move Members"),
      "Bot voice move permission listed"
    );
    assert(summary.includes("Blue team chat"), "Team send access listed");
  } finally {
    fixture.restore();
  }
});

test("An unavailable pre-flight audit never blocks announcement confirmation", async () => {
  const fixture = makeFixture();
  const command = new AnnouncementCommand() as any;
  const originalAudit = GameChannelPreflight.run;
  const originalConfirm = command.handleAnnouncementConfirm;
  const originalError = console.error;
  let confirmations = 0;
  const responses: string[] = [];
  const game = GameInstance.getInstance();
  game.reset();
  try {
    GameChannelPreflight.run = async () => {
      throw new Error("Discord permissions unavailable");
    };
    console.error = () => {};
    command.handleAnnouncementConfirm = async () => {
      confirmations++;
    };
    await command.handleButtonPress({
      customId: "announcement-confirm-noping",
      guild: fixture.guild,
      user: { id: "organiser-user" },
      deferReply: async () => {},
      editReply: async (value: string) => {
        responses.push(value);
      },
    } as any);
    assertEqual(confirmations, 1, "Announcement continues when audit throws");
    assert(
      responses[0].includes("Announcement sent") &&
        responses[0].includes("Pre-flight could not complete") &&
        responses[0].includes("/announce check"),
      "Organiser receives a private caution to check permissions"
    );
  } finally {
    GameChannelPreflight.run = originalAudit;
    command.handleAnnouncementConfirm = originalConfirm;
    console.error = originalError;
    game.reset();
    fixture.restore();
  }
});

test("An actual announcement delivery failure does not claim success", async () => {
  const fixture = makeFixture();
  const command = new AnnouncementCommand() as any;
  const originalConfirm = command.handleAnnouncementConfirm;
  const originalError = console.error;
  const game = GameInstance.getInstance();
  game.reset();
  const responses: string[] = [];
  try {
    command.handleAnnouncementConfirm = async () => {
      throw new Error("Announcement channel send failed");
    };
    console.error = () => {};
    await command.handleButtonPress({
      customId: "announcement-confirm-ping",
      guild: fixture.guild,
      user: { id: "organiser-user" },
      deferReply: async () => {},
      editReply: async (value: string) => {
        responses.push(value);
      },
    } as any);
    assert(
      responses[0].includes("Could not send the announcement") &&
        !responses[0].includes("Announcement sent"),
      "Sending errors are still reported accurately"
    );
  } finally {
    command.handleAnnouncementConfirm = originalConfirm;
    console.error = originalError;
    game.reset();
    fixture.restore();
  }
});
test("/announce check is organiser-only and confirmation warns without blocking either ping mode", async () => {
  const fixture = makeFixture();
  const command = new AnnouncementCommand() as any;
  const game = GameInstance.getInstance();
  game.reset();
  const original = command.handleAnnouncementConfirm;
  const sentWithPing: boolean[] = [];
  command.handleAnnouncementConfirm = async (
    _guild: unknown,
    ping: boolean
  ) => {
    sentWithPing.push(ping);
  };
  try {
    const replies: string[] = [];
    const checkInteraction: any = {
      guild: fixture.guild,
      user: { id: "organiser-user" },
      options: { getSubcommand: () => "check" },
      deferReply: async () => {},
      editReply: async (value: string) => {
        replies.push(value);
      },
    };
    await command.execute(checkInteraction);
    assert(
      replies[0].includes("passed"),
      "Manual check available to organiser"
    );

    const confirm = async (userId = "organiser-user", ping = false) => {
      const response: string[] = [];
      await command.handleButtonPress({
        customId: ping
          ? "announcement-confirm-ping"
          : "announcement-confirm-noping",
        guild: fixture.guild,
        user: { id: userId },
        deferReply: async () => {},
        editReply: async (text: string) => {
          response.push(text);
        },
      } as any);
      return response[0] ?? "";
    };

    fixture.channels
      .get("blueTeamChat")!
      .grants.get(fixture.guild.id)!
      .add(P.ViewChannel);
    const warned = await confirm();
    assert(
      warned.includes("Announcement sent") &&
        warned.includes("Pre-flight found") &&
        warned.includes("Blue team chat"),
      "Announcement is sent but organiser is warned about a public team channel"
    );
    assertEqual(
      sentWithPing.length,
      1,
      "Permission warning does not block announcement"
    );
    assertEqual(
      sentWithPing[0],
      false,
      "No-ping confirmation preserves its setting"
    );

    fixture.channels
      .get("redTeamChat")!
      .grants.get(fixture.roles.gameNotify)!
      .add(P.ViewChannel);
    const notifyWarned = await confirm("organiser-user", true);
    assert(
      notifyWarned.includes("Announcement sent with ping") &&
        notifyWarned.includes("Game Notify role"),
      "Automatic confirmation warns on notification-role team access"
    );
    assertEqual(sentWithPing.length, 2, "Notification-role leak is advisory");
    assertEqual(
      sentWithPing[1],
      true,
      "Ping confirmation still sends with ping"
    );
    fixture.channels
      .get("redTeamChat")!
      .grants.get(fixture.roles.gameNotify)!
      .delete(P.ViewChannel);

    fixture.channels
      .get("blueTeamChat")!
      .grants.get(fixture.guild.id)!
      .delete(P.ViewChannel);
    const notOrganiser = await confirm("stranger");
    assert(
      notOrganiser.includes("Only organisers"),
      "Clickers are checked as organisers"
    );
    assertEqual(
      sentWithPing.length,
      2,
      "No announcement sent by non-organiser"
    );

    const allowed = await confirm();
    assert(
      allowed.includes("Pre-flight passed"),
      "Clean settings allow confirmation"
    );
    assertEqual(
      sentWithPing.length,
      3,
      "Confirmation still runs when the audit passes"
    );
  } finally {
    command.handleAnnouncementConfirm = original;
    game.reset();
    fixture.restore();
  }
});
