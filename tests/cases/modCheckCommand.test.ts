import { MessageFlags } from "discord.js";
import ModCheckCommand from "../../src/commands/ModCheckCommand";
import {
  buildModerationReview,
  observedMinecraftUUIDs,
} from "../../src/logic/ModerationReview";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";
import { prismaClient } from "../../src/database/prismaClient";
import { MojangAPI } from "../../src/api/MojangAPI";
import { MinecraftNameHistoryAPI } from "../../src/api/MinecraftNameHistoryAPI";
import { inspectAccountConsistency } from "../../src/logic/ModerationIssues";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { createChatInputInteraction } from "../framework/mocks";

const firstUUID = "a".repeat(32);
const secondUUID = "b".repeat(32);

const player = {
  id: "P1",
  discordSnowflake: "111111111111111111",
  latestIGN: "New_Name",
  minecraftAccounts: ["Old_Name", "New_Name"],
  primaryMinecraftAccount: firstUUID,
  createdAt: new Date("2024-01-01T00:00:00Z"),
};

function interaction(organiser: boolean) {
  const member = { roles: { cache: { has: () => organiser } } };
  return createChatInputInteraction("organiser", {
    strings: { player: "New_Name" },
    guild: {
      id: "guild-1",
      members: {
        cache: { get: () => member },
        fetch: async () => member,
      },
    } as any,
  });
}

function field(embed: any, name: string): string {
  return String(
    embed.data.fields?.find((entry: any) => entry.name === name)?.value ?? ""
  );
}

test("/modcheck refuses non-organisers before reading the player", async () => {
  const command = new ModCheckCommand();
  const original = PrismaUtils.findPlayer;
  let didRead = false;
  try {
    (PrismaUtils as any).findPlayer = async () => {
      didRead = true;
      return player;
    };
    const request = interaction(false);
    await command.execute(request);
    assert(!didRead, "Unauthorised users must not read player records");
    const reply = request.replies[0];
    assert(reply.type === "reply", "Denial should be immediate");
    assert(
      reply.payload.flags === MessageFlags.Ephemeral,
      "Denial must be private"
    );
  } finally {
    (PrismaUtils as any).findPlayer = original;
  }
});

test("/modcheck shows punishment history, UUID evidence and IGN verification publicly", async () => {
  const command = new ModCheckCommand();
  const originalFind = PrismaUtils.findPlayer;
  const originalPunishments = prismaClient.playerPunishment.findMany;
  const originalGames = prismaClient.gameParticipation.findMany;
  const originalEvents = prismaClient.standaloneEvent.findMany;
  const originalSignups = prismaClient.eventSignup.findMany;
  const originalPlayers = prismaClient.player.findMany;
  const originalFirst = prismaClient.player.findFirst;
  const originalReverse = MojangAPI.uuidToUsername;
  const lookedUp: string[] = [];
  const originalPermission = PermissionsUtil.hasRole;
  const originalLookup = MojangAPI.lookupUsername;
  const originalHistory = MinecraftNameHistoryAPI.lookupByUUID;
  let signupQueries = 0;
  try {
    (PermissionsUtil as any).hasRole = () => true;
    (MojangAPI as any).lookupUsername = async (name: string) => {
      lookedUp.push(name);
      if (name === "Old_Name") return { status: "notFound" };
      if (name === "Older_Name") return { status: "unavailable" };
      return { status: "found", uuid: name === "Other_Name" ? secondUUID : firstUUID };
    };
    MojangAPI.uuidToUsername = async () => player.latestIGN;
    (prismaClient.player as any).findFirst = async (args: any) =>
      args.where.primaryMinecraftAccount === firstUUID ? player : null;
    MinecraftNameHistoryAPI.lookupByUUID = async (uuid, scope) => {
      assert(scope?.guildId === "guild-1", "Name history must use invoking guild");
      assert(uuid === firstUUID, "External lookup must use primary UUID");
      return { status: "found", uuid, currentUsername: "New_Name", names: [], providers: [], partial: true, suppressed: false };
    };
    (PrismaUtils as any).findPlayer = async () => player;
    (prismaClient.playerPunishment as any).findMany = async () => [
      {
        strikeCount: 2,
        reasons: ["Spam", "Late attendance"],
        punishmentDates: [new Date("2025-02-04"), new Date("2025-03-01")],
        punishmentExpiry: new Date("2099-03-01"),
      },
    ];
    (prismaClient.gameParticipation as any).findMany = async () => [
      { ignUsed: "Old_Name" },
      { ignUsed: "Older_Name" },
    ];
    (prismaClient.standaloneEvent as any).findMany = async (args: any) => {
      assert(args.where.guildId === "guild-1", "Events must be guild-scoped");
      return [{ id: "event1", state: "OPEN" }];
    };
    (prismaClient.eventSignup as any).findMany = async (args: any) => {
      signupQueries++;
      assert(
        args.where.eventId.in[0] === "event1",
        "Signups must be guild-scoped"
      );
      if (args.where.discordUserId) {
        return [
          {
            eventId: "event1",
            status: "CONFIRMED",
            discordUserId: player.discordSnowflake,
            minecraftUUID: secondUUID.toUpperCase(),
            minecraftUsername: "Other_Name",
          },
        ];
      }
      return [
        {
          discordUserId: "222222222222222222",
          minecraftUUID: secondUUID,
          minecraftUsername: "Other_Name",
        },
      ];
    };
    (prismaClient.player as any).findMany = async (args: any) => {
      if (args.where.minecraftAccounts?.has) return [player];
      if (args.where.id?.not) return [];
      assert(args.where.NOT.id === player.id, "Exclude current player");
      return [
        {
          discordSnowflake: "333333333333333333",
          primaryMinecraftAccount: firstUUID,
          minecraftAccounts: [],
        },
      ];
    };

    const request = interaction(true);
    let deferOptions: any;
    const defer = request.deferReply.bind(request);
    (request as any).deferReply = async (options: any) => {
      deferOptions = options;
      return defer(options);
    };
    await command.execute(request);
    assert(request.deferred, "Should defer a result");
    assert(!deferOptions?.flags && !deferOptions?.ephemeral, "Successful result must be public");
    const result = request.replies.find((r: any) => r.type === "editReply");
    const embed = result?.payload?.embeds?.[0];
    assert(!!embed, "Result must be an embed");
    assert(
      field(embed, "Punishments").includes("2 recorded entries") &&
        field(embed, "Punishments").includes("Spam"),
      "Should show actual punishments and dates"
    );
    assert(
      field(embed, "Minecraft accounts observed").includes(
        "2 distinct Minecraft accounts"
      ) &&
        field(embed, "Minecraft accounts observed").includes(
          "Exact switch count unknown"
        ),
      "Should distinguish observed IDs from an unrecorded change count"
    );
    assert(
      field(embed, "Recorded Minecraft names").includes("Older\\_Name") &&
        field(embed, "Recorded Minecraft names").includes("do not establish"),
      "Should include game names without mistaking them for account changes"
    );
    assert(
      field(embed, "Account consistency").includes("active event signup") &&
        field(embed, "Account consistency").includes(
          "same primary Minecraft UUID"
        ),
      "Should flag event identity drift and duplicate ownership"
    );
    assert(
      field(embed, "Possible alt-account overlap").includes(
        "222222222222222222"
      ) &&
        field(embed, "Possible alt-account overlap").includes(
          "333333333333333333"
        ),
      "Should show both confirmed UUID-overlap sources"
    );
    const verification = field(embed, "IGN verification (recorded names)");
    for (const phrase of ["Same Minecraft account", "Different Minecraft account", "not registered", "historical match", "service unavailable"]) {
      assert(verification.includes(phrase), `Verification should include: ${phrase}`);
    }
    assert(lookedUp.length === 4, "Should check each distinct local name once, including reuse of current lookup");
    assert(field(embed, "Name history (linked account)").includes("0 previous names found"), "External history must appear separately");
    assert(embed.length <= 6000, "Embed must stay within the total Discord limit");
    assert(
      signupQueries === 2,
      "Should inspect signups and related Discord IDs"
    );
    assert(
      result.payload.allowedMentions.parse.length === 0,
      "Names and reasons must never ping anyone"
    );

    MinecraftNameHistoryAPI.lookupByUUID = async () => { throw new Error("Mock provider outage"); };
    const failed = interaction(true);
    await command.execute(failed);
    const failedEmbed = failed.replies.find((r: any) => r.type === "editReply")?.payload?.embeds?.[0];
    assert(!!failedEmbed, "External outage must not prevent the moderation embed");
    assert(field(failedEmbed, "Punishments") === field(embed, "Punishments"), "Punishment evidence must be preserved");
    assert(field(failedEmbed, "Possible alt-account overlap") === field(embed, "Possible alt-account overlap"), "External outage must not affect alt assessment");
    assert(field(failedEmbed, "Name history (linked account)").includes("unavailable"), "External outage must be reported separately");
  } finally {
    (PrismaUtils as any).findPlayer = originalFind;
    (prismaClient.playerPunishment as any).findMany = originalPunishments;
    (prismaClient.gameParticipation as any).findMany = originalGames;
    (prismaClient.standaloneEvent as any).findMany = originalEvents;
    (prismaClient.eventSignup as any).findMany = originalSignups;
    (prismaClient.player as any).findMany = originalPlayers;
    (prismaClient.player as any).findFirst = originalFirst;
    MojangAPI.uuidToUsername = originalReverse;
    (PermissionsUtil as any).hasRole = originalPermission;
    (MojangAPI as any).lookupUsername = originalLookup;
    MinecraftNameHistoryAPI.lookupByUUID = originalHistory;
  }
});

test("/modcheck reports verified Minecraft and data consistency problems", () => {
  const diagnostics = inspectAccountConsistency(
    {
      ...player,
      minecraftAccounts: ["Old_Name", secondUUID],
    },
    [
      {
        reasons: ["Afk", "Late"],
        punishmentDates: [new Date("2025-03-01")],
        strikeCount: 3,
      },
      { reasons: [], punishmentDates: [], strikeCount: 0 },
    ],
    [
      { minecraftUUID: secondUUID, minecraftUsername: "Old_Name" },
      { minecraftUUID: "invalid", minecraftUsername: "Bad_Name" },
    ],
    [
      {
        discordSnowflake: "222222222222222222",
        primaryMinecraftAccount: firstUUID,
      },
    ],
    [{ discordSnowflake: "333333333333333333" }],
    { status: "found", uuid: secondUUID }
  );
  const explanations = diagnostics.issues
    .map((issue) => issue.explanation)
    .join("\n");
  for (const phrase of [
    "another player record",
    "Another player record claims the same primary Minecraft UUID",
    "different UUID from the current player link",
    "invalid Minecraft UUID",
    "Multiple punishment records",
    "dates have different counts",
    "strike count",
    "different Minecraft UUID than the stored primary link",
    "malformed",
  ]) {
    assert(explanations.includes(phrase), `Should detect: ${phrase}`);
  }
  assert(
    diagnostics.issues.every(
      (issue) => issue.severity === "action" || issue.severity === "review"
    ),
    "Issues must be explicitly classified"
  );
});

test("/modcheck distinguishes historical changes, rename and service outages from errors", () => {
  const noIssues = inspectAccountConsistency(
    player,
    [],
    [
      {
        minecraftUUID: firstUUID.toUpperCase(),
        minecraftUsername: player.latestIGN,
      },
    ],
    [],
    [],
    { status: "found", uuid: firstUUID }
  );
  assert(
    noIssues.issues.length === 0,
    "Consistent active signups must not be flagged"
  );
  assert(
    noIssues.liveCheck.includes("resolves to the stored primary"),
    "Shows successful verification"
  );

  const unavailable = inspectAccountConsistency(player, [], [], [], [], {
    status: "unavailable",
  });
  assert(
    unavailable.issues.length === 0,
    "Service outages are not account issues"
  );
  assert(
    unavailable.liveCheck.includes("unavailable"),
    "Report limited verification"
  );

  const rename = inspectAccountConsistency(player, [], [], [], [], {
    status: "notFound",
  });
  assert(
    rename.issues.length === 1 && rename.issues[0].severity === "review",
    "An unresolvable IGN needs investigation but is not a proven identity conflict"
  );

  const legacy = inspectAccountConsistency(
    { ...player, primaryMinecraftAccount: "Old_Name", latestIGN: null },
    [],
    [],
    [],
    []
  );
  assert(
    legacy.issues.some((issue) =>
      issue.explanation.includes("not a valid UUID")
    ) &&
      legacy.issues.some((issue) =>
        issue.explanation.includes("IGN is missing")
      ),
    "Invalid legacy identity data must be visible"
  );
});

test("/modcheck does not turn IGN changes or lack of overlap into an alt verdict", () => {
  const uuidList = observedMinecraftUUIDs(player as any, [
    {
      discordUserId: player.discordSnowflake,
      minecraftUUID: firstUUID.toUpperCase(),
      minecraftUsername: "Old_Name",
    },
  ]);
  assert(uuidList.length === 1, "Case-insensitive duplicate UUIDs count once");
  const embed = buildModerationReview(
    player as any,
    [],
    [{ ignUsed: "EvenOlderName" }],
    [],
    [],
    []
  );
  assert(
    field(embed, "Minecraft accounts observed").includes(
      "1 distinct Minecraft account"
    ) &&
      field(embed, "Minecraft accounts observed").includes(
        "Exact switch count unknown"
      ),
    "A list of names should not be counted as changes of account"
  );
  assert(
    field(embed, "Possible alt-account overlap").includes(
      "No shared Minecraft accounts found"
    ),
    "No identified link is not proof that someone is not an alt"
  );
  for (const item of embed.data.fields ?? []) {
    assert(
      (item.value?.length ?? 0) <= 1024,
      "All fields fit Discord embed limits"
    );
  }
});
