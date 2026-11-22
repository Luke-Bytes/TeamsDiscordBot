import { ChannelType, InteractionContextType, MessageFlags } from "discord.js";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import AskCommand from "../../src/commands/AskCommand";
import { ConfigManager } from "../../src/ConfigManager";
import { AiSettings } from "../../src/ai/AiConfig";
import { safeDiscordText } from "../../src/ai/AiAssistant";

const commandChannelId = "111111111111111111";
const settings: AiSettings = {
  enabled: true,
  channelIds: new Set([commandChannelId]),
  dailyRequestLimit: 50,
};

function mockDm(
  options: {
    organiser?: boolean;
    member?: boolean;
    channelFound?: boolean;
    context?: InteractionContextType;
    guildId?: string;
  } = {}
) {
  let membershipChecks = 0;
  let channelLookups = 0;
  const replies: Array<{ content?: string; flags?: number }> = [];
  const edits: Array<{ content?: string }> = [];
  const defers: any[] = [];
  const guild = {
    id: options.guildId ?? "approved-guild",
    members: {
      fetch: async ({ user, force }: { user: string; force: boolean }) => {
        membershipChecks++;
        assert(
          user === "requesting-user" && force,
          "Fresh membership lookup uses the actual DM sender"
        );
        if (options.member === false) throw new Error("Not a guild member");
        return { roles: { cache: { has: () => options.organiser ?? false } } };
      },
    },
  };
  const interaction = {
    guild: null,
    guildId: null,
    channel: { type: ChannelType.DM },
    context: options.context ?? InteractionContextType.BotDM,
    channelId: "a-dm-channel",
    user: { id: "requesting-user" },
    client: {
      channels: {
        fetch: async (id: string) => {
          channelLookups++;
          assert(
            id === commandChannelId,
            "Only the configured command channel resolves the trusted guild"
          );
          return options.channelFound === false
            ? null
            : { type: ChannelType.GuildText, guild };
        },
      },
    },
    options: { getString: () => "How do I register?" },
    reply: async (reply: any) => {
      replies.push(reply);
    },
    deferReply: async (defer: any) => {
      defers.push(defer);
    },
    editReply: async (edit: any) => {
      edits.push(edit);
    },
  };
  return {
    guild,
    interaction,
    replies,
    edits,
    defers,
    membershipChecks: () => membershipChecks,
    channelLookups: () => channelLookups,
  };
}

test("DM /ask uses its configured guild and logs only the sanitised delivered answer", async () => {
  const mock = mockDm();
  const oldFetch = globalThis.fetch;
  const oldInfo = console.info;
  const previousKey = process.env.MC_AI_GROQ_KEY;
  const previousDirectory = process.env.CREDENTIALS_DIRECTORY;
  const dev = ConfigManager.getConfig().dev;
  const previousDevEnabled = dev.enabled;
  dev.enabled = false;
  const logs: string[] = [];
  const requests: any[] = [];
  try {
    process.env.MC_AI_GROQ_KEY = "offline-groq-test-credential";
    delete process.env.CREDENTIALS_DIRECTORY;
    console.info = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      assert(
        url === "https://api.groq.com/openai/v1/chat/completions",
        "DM inference uses selected provider"
      );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "Use /register.\nNo secrets: gsk_abcdefghijklmnopqrstuv",
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    await new AskCommand(settings).execute(mock.interaction as any);
    assert(
      mock.channelLookups() === 1 && mock.membershipChecks() >= 3,
      "DM resolves the approved guild and checks membership before and after inference"
    );
    assert(
      mock.replies.length === 0 &&
        mock.defers.length === 1 &&
        mock.defers[0] === undefined,
      "DM works without an ephemeral response flag (the DM channel is private)"
    );
    assert(requests.length === 1, "Exactly one inference request");
    assert(
      !requests[0].tools?.some(
        (tool: any) => tool.function.name === "get_organiser_status"
      ),
      "DM player never sees organiser-only tools"
    );
    const delivered = mock.edits[0]?.content ?? "";
    assert(
      delivered.includes("Use /register.") &&
        !delivered.includes("Sources:") &&
        !delivered.includes("Data:") &&
        !delivered.includes("docs/ai/") &&
        !delivered.includes("sha256:"),
      "DM answer has no provenance footer even when guides were retrieved"
    );
    assert(
      delivered.includes("[credential omitted]") && !delivered.includes("gsk_"),
      "Credential-like model text is removed before delivery"
    );
    assert(
      logs.length === 1 &&
        logs[0].includes("scope=dm") &&
        logs[0].includes("provider=groq"),
      "DM response is logged with safe metadata"
    );
    const rawLogReply = logs[0].split(" reply=")[1];
    assert(
      JSON.parse(rawLogReply) === delivered,
      "PM2 log contains exactly the user-visible answer, without source footer"
    );
    assert(
      !logs[0].includes("How do I register?") &&
        !logs[0].includes("gsk_") &&
        logs[0].includes("\\n"),
      "No raw question, secret or multiline log injection"
    );
  } finally {
    dev.enabled = previousDevEnabled;
    globalThis.fetch = oldFetch;
    console.info = oldInfo;
    if (previousKey === undefined) delete process.env.MC_AI_GROQ_KEY;
    else process.env.MC_AI_GROQ_KEY = previousKey;
    if (previousDirectory === undefined)
      delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previousDirectory;
  }
});

test("DM /ask checks organiser role from fresh guild membership before advertising tools", async () => {
  const mock = mockDm({ organiser: true });
  mock.interaction.options.getString = () => "What is the current game state?";
  const oldFetch = globalThis.fetch;
  const oldInfo = console.info;
  const previousKey = process.env.MC_AI_GROQ_KEY;
  const previousDirectory = process.env.CREDENTIALS_DIRECTORY;
  const dev = ConfigManager.getConfig().dev;
  const previousDevEnabled = dev.enabled;
  dev.enabled = false;
  let sawOrganiserTools = false;
  try {
    process.env.MC_AI_GROQ_KEY = "offline-groq-test-credential";
    delete process.env.CREDENTIALS_DIRECTORY;
    console.info = () => undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      sawOrganiserTools = request.tools.some(
        (tool: any) => tool.function.name === "get_organiser_status"
      );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "Please check /game diagnostics." },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    await new AskCommand(settings).execute(mock.interaction as any);
    assert(
      sawOrganiserTools && mock.membershipChecks() >= 3,
      "Verified organiser sees the same read-only tools in a DM as in the configured guild"
    );
  } finally {
    dev.enabled = previousDevEnabled;
    globalThis.fetch = oldFetch;
    console.info = oldInfo;
    if (previousKey === undefined) delete process.env.MC_AI_GROQ_KEY;
    else process.env.MC_AI_GROQ_KEY = previousKey;
    if (previousDirectory === undefined)
      delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previousDirectory;
  }
});

test("DM /ask denies non-members and missing configured channels without provider calls", async () => {
  const dev = ConfigManager.getConfig().dev;
  const previousDevEnabled = dev.enabled;
  dev.enabled = false;
  const oldFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls++;
    throw new Error("Provider must never be called");
  }) as typeof fetch;
  try {
    const memberMissing = mockDm({ member: false });
    await new AskCommand(settings).execute(memberMissing.interaction as any);
    assert(
      memberMissing.edits[0]?.content?.includes(
        "Unable to verify server membership"
      ),
      "Former or unknown guild members are denied"
    );
    const channelMissing = mockDm({ channelFound: false });
    await new AskCommand(settings).execute(channelMissing.interaction as any);
    assert(
      channelMissing.replies[0]?.content?.includes("verified server members") &&
        channelMissing.membershipChecks() === 0,
      "No guessed guild or provider call when configured channel cannot be resolved"
    );
    const unconfigured = mockDm();
    await new AskCommand({ ...settings, channelIds: new Set() }).execute(
      unconfigured.interaction as any
    );
    assert(
      unconfigured.replies[0]?.content?.includes("verified server members") &&
        unconfigured.channelLookups() === 0,
      "Empty command-channel configuration is not an open DM policy"
    );
    assert(
      providerCalls === 0,
      "Denials happen before external provider egress"
    );
  } finally {
    globalThis.fetch = oldFetch;
    dev.enabled = previousDevEnabled;
  }
});

test("DM /ask respects the dev-guild restriction and remains disabled when AI is off", async () => {
  const conf = ConfigManager.getConfig();
  const original = { ...conf.dev };
  try {
    conf.dev.enabled = true;
    conf.dev.guildId = "another-guild";
    const denied = mockDm();
    await new AskCommand(settings).execute(denied.interaction as any);
    assert(
      denied.replies[0]?.content?.includes("verified server members") &&
        denied.membershipChecks() === 0,
      "Dev-only guild isolation also applies to DMs"
    );
  } finally {
    Object.assign(conf.dev, original);
  }
  const disabled = mockDm();
  await new AskCommand({ ...settings, enabled: false }).execute(
    disabled.interaction as any
  );
  assert(
    disabled.replies[0]?.content?.includes("not enabled") &&
      disabled.channelLookups() === 0,
    "Disabled assistant does not resolve DM guilds"
  );
});

test("Sanitised response text also redacts credential patterns before PM2 logging", () => {
  const output = safeDiscordText(
    "Key MC_AI_GEMINI_KEY=abcDEFGHIJKLMN and BOT_TOKEN=super-secret\n" +
      "link https://example.invalid @everyone"
  );
  assert(
    !output.includes("abcDEFGHIJKLMN") &&
      !output.includes("super-secret") &&
      !output.includes("example.invalid") &&
      !output.includes("@everyone"),
    "Model responses do not expose obvious key, URL or mass-mention patterns"
  );
});
