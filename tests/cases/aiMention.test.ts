import { ChannelType, InteractionContextType, MessageFlags } from "discord.js";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { prismaClient } from "../../src/database/prismaClient";
import { ConfigManager } from "../../src/ConfigManager";
import { AiSettings, getAiSettings } from "../../src/ai/AiConfig";
import AskCommand from "../../src/commands/AskCommand";
import {
  AiMentionHandler,
  extractNaviQuestion,
  mentionChannelBlacklist,
} from "../../src/interactions/AiMentionHandler";
import { GameRecoveryCoordinator } from "../../src/logic/ActiveGameRecovery";

const BOT = "999999999999999999";
const HOME = "111111111111111111";
const PICKING = "222222222222222222";
const ANNOUNCEMENTS = "333333333333333333";
const FEED = "444444444444444444";
const EXTRA = "555555555555555555";
const GENERAL = "666666666666666666";
const GUILD = "fw-home-guild";
const channels = {
  ...ConfigManager.getConfig().channels,
  botCommands: HOME,
  teamPickingChat: PICKING,
  announcements: ANNOUNCEMENTS,
  gameFeed: FEED,
};
const settings: AiSettings = {
  enabled: true,
  channelIds: new Set([HOME]),
  dailyRequestLimit: 50,
  mentionExcludedChannels: new Set([EXTRA]),
};

function scenario(
  options: {
    content?: string;
    channelId?: string;
    channelType?: ChannelType;
    parentId?: string | null;
    guildId?: string | null;
    userId?: string;
    member?: boolean;
    organiser?: boolean;
    bot?: boolean;
    webhook?: boolean;
    mentioned?: boolean;
    failReply?: boolean;
    homeAccessible?: boolean;
  } = {}
) {
  const authorId = options.userId ?? "member-one";
  const guildId = options.guildId === undefined ? GUILD : options.guildId;
  const replies: any[] = [];
  const sequence: string[] = [];
  const checks: string[] = [];
  let homeLookups = 0;
  const guild = {
    id: guildId,
    memberCount: 4,
    members: {
      fetch: async (arg?: any) => {
        if (arg?.user) {
          checks.push(arg.user);
          assert(
            arg.user === authorId && arg.force === true,
            "Fresh Discord user lookup"
          );
          if (options.member === false) throw new Error("Not a member");
          return {
            user: { bot: false },
            roles: { cache: { has: () => options.organiser ?? false } },
          };
        }
        return { filter: () => ({ map: () => [] }) };
      },
    },
    commands: { fetch: async () => null },
  };
  const client = {
    user: { id: BOT },
    channels: {
      fetch: async (channelId: string) => {
        homeLookups++;
        assert(
          channelId === HOME,
          "Only the configured home-guild channel may be resolved"
        );
        return options.homeAccessible === false
          ? null
          : { type: ChannelType.GuildText, guild: { ...guild, id: GUILD } };
      },
    },
    application: { commands: { fetch: async () => null } },
  };
  const message = {
    content: options.content ?? `<@${BOT}> How do I register?`,
    guild: guildId === null ? null : guild,
    guildId,
    client,
    author: { id: authorId, bot: options.bot ?? false },
    webhookId: options.webhook ? "webhook" : null,
    mentions: {
      users: {
        has: (id: string) => id === BOT && (options.mentioned ?? true),
      },
    },
    channel: {
      type: options.channelType ?? ChannelType.GuildText,
      parentId: options.parentId ?? null,
      sendTyping: async () => {
        sequence.push("typing");
      },
    },
    channelId: options.channelId ?? GENERAL,
    reply: async (args: any) => {
      sequence.push("reply");
      if (options.failReply) throw new Error("Message deleted");
      replies.push(args);
    },
  };
  const slashReplies: any[] = [];
  const edits: any[] = [];
  const defers: any[] = [];
  const interaction: any = {
    guild,
    guildId,
    channelId: HOME,
    channel: { type: ChannelType.GuildText },
    context: InteractionContextType.Guild,
    user: { id: authorId },
    client,
    options: { getString: () => "How do I register?" },
    deferred: false,
    replied: false,
    deferReply: async (arg: any) => {
      defers.push(arg);
      interaction.deferred = true;
    },
    editReply: async (arg: any) => {
      edits.push(arg);
    },
    reply: async (arg: any) => {
      slashReplies.push(arg);
      interaction.replied = true;
    },
  };
  return {
    message,
    interaction,
    replies,
    sequence,
    checks,
    edits,
    defers,
    slashReplies,
    homeLookups: () => homeLookups,
  };
}

async function withProvider(
  run: (requests: any[]) => Promise<void>,
  responseText = "Use /register. <@123456789012345678> @everyone"
) {
  const oldFetch = globalThis.fetch;
  const oldFind = prismaClient.player.findUnique;
  const oldKey = process.env.MC_AI_GROQ_KEY;
  const oldDir = process.env.CREDENTIALS_DIRECTORY;
  const dev = ConfigManager.getConfig().dev;
  const oldDev = { ...dev };
  const requests: any[] = [];
  try {
    dev.enabled = false;
    process.env.MC_AI_GROQ_KEY = "offline-groq-test-credential";
    delete process.env.CREDENTIALS_DIRECTORY;
    (prismaClient.player as any).findUnique = async () => null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: responseText },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    await run(requests);
  } finally {
    Object.assign(dev, oldDev);
    globalThis.fetch = oldFetch;
    prismaClient.player.findUnique = oldFind;
    if (oldKey === undefined) delete process.env.MC_AI_GROQ_KEY;
    else process.env.MC_AI_GROQ_KEY = oldKey;
    if (oldDir === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = oldDir;
  }
}

test("Mention feature defaults and mandatory blacklist preserve the /ask channel contract", () => {
  const enabled = getAiSettings({
    channels: channels as any,
    ai: { enabled: true, mentionExcludedChannels: [EXTRA, "not-a-snowflake"] },
  });
  const excluded = mentionChannelBlacklist(channels, enabled);
  assert(
    enabled.mentionEnabled === true && enabled.channelIds.has(HOME),
    "Mention-on default"
  );
  assert(
    [PICKING, ANNOUNCEMENTS, FEED, EXTRA].every((id) => excluded.has(id)) &&
      !excluded.has(GENERAL) &&
      !excluded.has("not-a-snowflake"),
    "Built-in + extra exclusions, with invalid IDs discarded"
  );
  assert(
    getAiSettings({
      channels: channels as any,
      ai: { enabled: true, mentionEnabled: false },
    }).mentionEnabled === false &&
      getAiSettings({
        channels: channels as any,
        ai: { enabled: false, mentionEnabled: true },
      }).mentionEnabled === false,
    "Mentions may be switched off independently, never on without AI"
  );
});

test("Guild /ask uses the same blacklist and eligible thread types as @Navi", async () => {
  await withProvider(async (requests) => {
    const configured = ConfigManager.getConfig().channels;
    const previous = {
      teamPickingChat: configured.teamPickingChat,
      announcements: configured.announcements,
      gameFeed: configured.gameFeed,
    };
    Object.assign(configured, {
      teamPickingChat: PICKING,
      announcements: ANNOUNCEMENTS,
      gameFeed: FEED,
    });
    try {
      for (const [channelId, type, parentId] of [
        [HOME, ChannelType.GuildText, null],
        [GENERAL, ChannelType.GuildText, null],
        [GENERAL, ChannelType.GuildAnnouncement, null],
        [GENERAL, ChannelType.PublicThread, GENERAL],
        [GENERAL, ChannelType.PrivateThread, GENERAL],
        [GENERAL, ChannelType.AnnouncementThread, GENERAL],
      ] as Array<[string, ChannelType, string | null]>) {
        const mock = scenario();
        mock.interaction.channelId = channelId;
        mock.interaction.channel = { type, parentId };
        await new AskCommand(settings).execute(mock.interaction as any);
        assert(
          mock.defers.length === 1 &&
            mock.edits.length === 1 &&
            mock.slashReplies.length === 0,
          `/ask must work publicly in allowed channel ${channelId} type ${type}`
        );
      }
      assert(
        requests.length === 6,
        "Eligible server /ask reaches the provider"
      );

      for (const channelId of [PICKING, ANNOUNCEMENTS, FEED, EXTRA]) {
        for (const threaded of [false, true]) {
          const mock = scenario();
          mock.interaction.channelId = threaded ? GENERAL : channelId;
          mock.interaction.channel = {
            type: threaded ? ChannelType.PublicThread : ChannelType.GuildText,
            parentId: threaded ? channelId : null,
          };
          await new AskCommand(settings).execute(mock.interaction as any);
          assert(
            mock.defers.length === 0 &&
              mock.edits.length === 0 &&
              mock.slashReplies[0]?.flags === MessageFlags.Ephemeral &&
              mock.slashReplies[0]?.content.includes(
                "allowed server channels"
              ) &&
              mock.homeLookups() === 0,
            "Excluded channels and their threads must deny before home lookup"
          );
        }
      }
      for (const type of [ChannelType.GuildVoice, ChannelType.GuildForum]) {
        const mock = scenario();
        mock.interaction.channelId = GENERAL;
        mock.interaction.channel = { type, parentId: null };
        await new AskCommand(settings).execute(mock.interaction as any);
        assert(
          mock.slashReplies[0]?.flags === MessageFlags.Ephemeral,
          "Unsupported channel types fail closed"
        );
      }
      for (const options of [
        { guildId: "other-guild" },
        { homeAccessible: false },
      ]) {
        const mock = scenario(options);
        mock.interaction.channelId = GENERAL;
        await new AskCommand(settings).execute(mock.interaction as any);
        assert(
          mock.slashReplies[0]?.content.includes("allowed server channels") &&
            mock.defers.length === 0,
          "Guild mismatch and inaccessible home anchor fail closed"
        );
      }
      assert(
        requests.length === 6,
        "No excluded, unsupported or foreign guild request reaches the provider"
      );
    } finally {
      Object.assign(configured, previous);
    }
  });
});

test("Slash /ask remains available when mention replies are disabled", async () => {
  await withProvider(async (requests) => {
    const mock = scenario();
    mock.interaction.channelId = GENERAL;
    await new AskCommand({ ...settings, mentionEnabled: false }).execute(
      mock.interaction as any
    );
    assert(
      requests.length === 1 &&
        mock.edits.length === 1 &&
        mock.slashReplies.length === 0,
      "Mention-specific opt-out does not turn off the slash command"
    );
  });
});

test("Only real, inline Discord bot mentions extract text at any position", () => {
  for (const content of [
    `<@${BOT}> what are my stats?`,
    `Hey <@!${BOT}>, how do I register?`,
    `Who won the last game <@${BOT}>`,
  ]) {
    const mock = scenario({ content });
    const question = extractNaviQuestion(mock.message as any, BOT);
    assert(
      question !== null && !question.includes(BOT),
      "Actual token removed"
    );
  }
  assert(
    extractNaviQuestion(
      scenario({ content: "Navi, hello" }).message as any,
      BOT
    ) === null &&
      extractNaviQuestion(
        scenario({ content: `<@${BOT}> hi`, mentioned: false }).message as any,
        BOT
      ) === null &&
      extractNaviQuestion(
        scenario({ content: "<@&999999999999999999> hi" }).message as any,
        BOT
      ) === null &&
      extractNaviQuestion(
        scenario({ content: "reply ping only" }).message as any,
        BOT
      ) === null,
    "Nicknames, untrusted literal tokens, role pings and incidental reply metadata are ignored"
  );
});

test("Eligible guild text and threads invoke Navi once with typing and a non-pinging native reply", async () => {
  await withProvider(async (requests) => {
    const ask = new AskCommand(settings);
    const handler = new AiMentionHandler(ask.assistant, channels);
    const mock = scenario({
      channelType: ChannelType.PublicThread,
      parentId: GENERAL,
    });
    assert(await handler.handle(mock.message as any), "Mention consumed");
    assert(requests.length === 1, "Exactly one AI request");
    assert(
      mock.sequence.join(",") === "typing,reply" &&
        mock.replies.length === 1 &&
        mock.replies[0].failIfNotExists === true &&
        mock.replies[0].allowedMentions.repliedUser === false &&
        mock.replies[0].allowedMentions.parse.length === 0,
      "One safe reply after typing"
    );
    assert(
      !mock.replies[0].content.includes("@everyone") &&
        !mock.replies[0].content.includes("<@123456789012345678>") &&
        mock.checks.length >= 3 &&
        mock.checks.every((id) => id === "member-one"),
      "Response is sanitised, and identity is verified throughout"
    );
  });
});

test("Blacklisted channels, nested threads, other guilds and missing home channel fail closed", async () => {
  await withProvider(async (requests) => {
    for (const channelId of [PICKING, ANNOUNCEMENTS, FEED, EXTRA]) {
      const mock = scenario({ channelId });
      const handler = new AiMentionHandler(
        new AskCommand(settings).assistant,
        channels
      );
      assert(
        await handler.handle(mock.message as any),
        "Excluded mention consumed"
      );
      assert(
        mock.replies.length === 0 && mock.homeLookups() === 0,
        "Silently excluded before network"
      );
    }
    for (const parentId of [PICKING, ANNOUNCEMENTS, FEED, EXTRA]) {
      const mock = scenario({
        channelType: ChannelType.PrivateThread,
        parentId,
      });
      assert(
        (await new AiMentionHandler(
          new AskCommand(settings).assistant,
          channels
        ).handle(mock.message as any)) && mock.replies.length === 0,
        "Excluded thread inherits its parent exclusion"
      );
    }
    const wrongGuild = scenario({ guildId: "foreign-guild" });
    await new AiMentionHandler(
      new AskCommand(settings).assistant,
      channels
    ).handle(wrongGuild.message as any);
    assert(wrongGuild.replies.length === 0, "No unrelated-guild AI");
    const missing = scenario({ homeAccessible: false });
    await new AiMentionHandler(
      new AskCommand(settings).assistant,
      channels
    ).handle(missing.message as any);
    assert(
      missing.replies.length === 0,
      "Missing home channel is not a guild wildcard"
    );
    assert(requests.length === 0, "No excluded mention reaches provider");
  });
});

test("DM, bot, webhook, plain, disabled and invalid messages never invoke AI", async () => {
  await withProvider(async (requests) => {
    const handler = new AiMentionHandler(
      new AskCommand(settings).assistant,
      channels
    );
    for (const opts of [
      { guildId: null },
      { bot: true },
      { webhook: true },
      { mentioned: false },
      { content: "Navi, what are my stats?" },
    ]) {
      const mock = scenario(opts);
      assert(
        !(await handler.handle(mock.message as any)),
        "Non-eligible input not consumed"
      );
    }
    for (const content of [
      `<@${BOT}>`,
      `<@${BOT}> hi`,
      `<@${BOT}> ${"x".repeat(451)}`,
      `<@${BOT}> BOT_TOKEN=sensitive`,
      `<@${BOT}> gsk_abcdefghijklmnopqrstuvwxyz`,
    ]) {
      const mock = scenario({ content });
      assert(
        await handler.handle(mock.message as any),
        "Invalid explicit mention consumed"
      );
      assert(mock.replies.length === 0, "Invalid mention stays silent");
    }
    for (const disabled of [
      { ...settings, enabled: false },
      { ...settings, mentionEnabled: false },
    ]) {
      const mock = scenario();
      assert(
        (await new AiMentionHandler(
          new AskCommand(disabled).assistant,
          channels
        ).handle(mock.message as any)) &&
          mock.replies.length === 0 &&
          mock.homeLookups() === 0,
        "Disabled AI cannot resolve provider or home guild"
      );
    }
    const conf = ConfigManager.getConfig().dev;
    const old = { ...conf };
    try {
      conf.enabled = true;
      conf.guildId = "another-dev-guild";
      const mock = scenario();
      await handler.handle(mock.message as any);
      assert(mock.replies.length === 0, "Dev guild restriction enforced");
    } finally {
      Object.assign(conf, old);
    }
    assert(requests.length === 0, "No ineligible provider calls");
  });
});

test("A mention shares /ask cooldown and admission, preserving the private slash denial", async () => {
  await withProvider(async (requests) => {
    const ask = new AskCommand(settings);
    const handler = new AiMentionHandler(ask.assistant, channels);
    const first = scenario();
    const second = scenario();
    await handler.handle(first.message as any);
    await ask.execute(second.interaction as any);
    assert(
      requests.length === 1 &&
        first.replies.length === 1 &&
        second.defers.length === 0 &&
        second.slashReplies[0].flags === MessageFlags.Ephemeral &&
        second.slashReplies[0].content.includes("Give me 5 more seconds"),
      "Slash cannot bypass prior mention cooldown"
    );

    const askOther = new AskCommand(settings);
    const fromSlash = scenario();
    const fromMention = scenario();
    await askOther.execute(fromSlash.interaction as any);
    await new AiMentionHandler(askOther.assistant, channels).handle(
      fromMention.message as any
    );
    assert(
      requests.length === 2 &&
        fromMention.replies[0]?.content.includes("Give me 5 more seconds"),
      "Mention cannot bypass prior slash cooldown"
    );
  }, "Use /register.");
});

test("In-flight limits apply across mention and /ask without queuing provider calls", async () => {
  await withProvider(async (requests) => {
    const ask = new AskCommand(settings);
    const handler = new AiMentionHandler(ask.assistant, channels);
    const first = scenario();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const oldFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls++;
      requests.push(JSON.parse(String(init.body)));
      arrived();
      await hold;
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: "Resolved" }, finish_reason: "stop" },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const processing = handler.handle(first.message as any);
      await started;
      const second = scenario();
      await ask.execute(second.interaction as any);
      assert(
        second.slashReplies[0]?.content.includes("still working") &&
          second.defers.length === 0 &&
          calls === 1,
        "A concurrent slash from same user is denied before inference"
      );
      release();
      await processing;
      assert(
        first.replies[0]?.content === "Resolved",
        "Original mention finishes"
      );
    } finally {
      release();
      globalThis.fetch = oldFetch;
    }
  });
});

test("Two concurrent AI slots and the daily budget are shared across entry points", async () => {
  await withProvider(async (requests) => {
    const ask = new AskCommand({ ...settings, dailyRequestLimit: 2 });
    const handler = new AiMentionHandler(ask.assistant, channels);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      calls++;
      if (calls === 2) ready();
      await hold;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Done" }, finish_reason: "stop" }],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const first = scenario({ userId: "player-1" });
      const second = scenario({ userId: "player-2" });
      const third = scenario({ userId: "player-3" });
      const a = handler.handle(first.message as any);
      const b = ask.execute(second.interaction as any);
      await bothStarted;
      await handler.handle(third.message as any);
      assert(
        calls === 2 &&
          third.replies[0]?.content.includes("daily AI request limit"),
        "Neither entry point creates an extra slot or budget"
      );
      release();
      await Promise.all([a, b]);
      assert(
        first.replies[0]?.content === "Done" &&
          second.edits[0]?.content === "Done",
        "Both admitted requests finish with their own Discord response"
      );
      const after = scenario({ userId: "player-4" });
      await ask.execute(after.interaction as any);
      assert(
        calls === 2 &&
          after.slashReplies[0]?.content.includes("daily AI request limit"),
        "Released concurrency does not replenish the daily process-local budget"
      );
    } finally {
      release();
      globalThis.fetch = originalFetch;
    }
  });
});

test("Membership and organiser permissions are fresh and consistent across both entry points", async () => {
  await withProvider(async (requests) => {
    const question = "How do I announce a match with /announce start?";
    const player = scenario({ content: `<@${BOT}> ${question}` });
    const organiser = scenario({ organiser: true });
    organiser.interaction.options.getString = () => question;
    const denied = scenario({
      member: false,
      content: `<@${BOT}> ${question}`,
    });
    await new AiMentionHandler(
      new AskCommand(settings).assistant,
      channels
    ).handle(player.message as any);
    await new AskCommand(settings).execute(organiser.interaction as any);
    await new AiMentionHandler(
      new AskCommand(settings).assistant,
      channels
    ).handle(denied.message as any);
    assert(
      requests.length === 2 &&
        player.checks.length >= 3 &&
        organiser.checks.length >= 3 &&
        denied.replies[0]?.content.includes(
          "Unable to verify server membership"
        ),
      "Only verified members can reach the provider"
    );
    const tools = (n: number) =>
      requests[n].tools.map((tool: any) => tool.function.name);
    assert(
      !tools(0).includes("get_organiser_status") &&
        !tools(0).includes("get_game_diagnostics") &&
        tools(1).includes("get_organiser_status"),
      "Member roles, not question text, gate organiser-only diagnostics"
    );
    assert(
      JSON.stringify(requests[0].messages) !== "" &&
        requests[0].messages[2].content === requests[1].messages[2].content,
      "Both methods use the same question and knowledge input"
    );
  }, "An organiser can use /announce start.");
});

test("Provider failures and missing reply messages remain safe and never retry elsewhere", async () => {
  await withProvider(async (requests) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("secret raw provider exception");
    }) as typeof fetch;
    try {
      const failed = scenario();
      await new AiMentionHandler(
        new AskCommand(settings).assistant,
        channels
      ).handle(failed.message as any);
      assert(
        failed.replies.length === 1 &&
          !failed.replies[0].content.includes("secret"),
        "Provider errors cannot leak internal diagnostics"
      );
      const deleted = scenario({ failReply: true });
      await new AiMentionHandler(
        new AskCommand(settings).assistant,
        channels
      ).handle(deleted.message as any);
      assert(
        deleted.sequence.length <= 3,
        "No uncontrolled reply retries/fallback sends"
      );
      assert(requests.length === 0, "No extra fake provider requests made");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Mention handling leaves non-mention game messages and recovery operation barriers intact", async () => {
  const handler = new AiMentionHandler(
    new AskCommand(settings).assistant,
    channels
  );
  const picking = scenario({ channelId: PICKING });
  const ordinaryPick = scenario({
    content: "playerIGN",
    mentioned: false,
    channelId: PICKING,
  });
  assert(
    (await handler.handle(picking.message as any)) &&
      !(await handler.handle(ordinaryPick.message as any)),
    "Navi mentions are consumed, ordinary team picks still flow to existing handlers"
  );
  const dm = scenario({ guildId: null });
  assert(
    !(await handler.handle(dm.message as any)),
    "Captain-plan DM path is not intercepted"
  );
  const active = GameRecoveryCoordinator.enterOperation();
  assert(Boolean(active), "Normal operations can enter the recovery barrier");
  active?.();
  GameRecoveryCoordinator.beginStartup();
  try {
    assert(
      GameRecoveryCoordinator.enterOperation() === null,
      "Frozen recovery prevents AI mention message processing at listener entry"
    );
  } finally {
    GameRecoveryCoordinator.finishStartup(null);
  }
});
