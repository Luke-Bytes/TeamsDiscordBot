import { ChannelType, InteractionContextType, MessageFlags } from "discord.js";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import AskCommand from "../../src/commands/AskCommand";
import { ConfigManager } from "../../src/ConfigManager";
import { AiSettings, AI_DEFAULTS } from "../../src/ai/AiConfig";

const approvedChannel = "111111111111111111";
const settings: AiSettings = {
  enabled: true,
  channelIds: new Set([approvedChannel]),
  dailyRequestLimit: 50,
};

function guildInteraction(question: string, organiser: boolean) {
  const deferred: any[] = [];
  const replies: any[] = [];
  const edits: any[] = [];
  let checks = 0;
  const guild = {
    id: "approved-guild",
    members: {
      fetch: async ({ user, force }: { user: string; force: boolean }) => {
        checks++;
        assert(
          user === "requesting-user" && force,
          "Role checks use trusted Discord identity"
        );
        return { roles: { cache: { has: () => organiser } } };
      },
    },
  };
  return {
    interaction: {
      guild,
      guildId: guild.id,
      channelId: approvedChannel,
      channel: { type: ChannelType.GuildText },
      context: InteractionContextType.Guild,
      user: { id: "requesting-user" },
      options: { getString: () => question },
      deferReply: async (options?: unknown) => {
        deferred.push(options);
      },
      editReply: async (options: unknown) => {
        edits.push(options);
      },
      reply: async (options: unknown) => {
        replies.push(options);
      },
    },
    deferred,
    edits,
    replies,
    checks: () => checks,
  };
}

async function withOfflineGroq(
  testFn: (requests: any[], logs: string[]) => Promise<void>,
  response: (request: any) => Response
) {
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  const previousKey = process.env.MC_AI_GROQ_KEY;
  const previousDirectory = process.env.CREDENTIALS_DIRECTORY;
  const dev = ConfigManager.getConfig().dev;
  const wasDev = dev.enabled;
  const requests: any[] = [];
  const logs: string[] = [];
  try {
    dev.enabled = false;
    process.env.MC_AI_GROQ_KEY = "offline-groq-test-credential";
    delete process.env.CREDENTIALS_DIRECTORY;
    console.info = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      requests.push(request);
      return response(request);
    }) as typeof fetch;
    await testFn(requests, logs);
  } finally {
    dev.enabled = wasDev;
    globalThis.fetch = previousFetch;
    console.info = previousInfo;
    if (previousKey === undefined) delete process.env.MC_AI_GROQ_KEY;
    else process.env.MC_AI_GROQ_KEY = previousKey;
    if (previousDirectory === undefined)
      delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previousDirectory;
  }
}

test("Guild /ask replies publicly with verified organiser tools and approved organiser guidance", async () => {
  const question = "How do I announce a match with /announce start?";
  const mock = guildInteraction(question, true);
  await withOfflineGroq(
    async (requests, logs) => {
      await new AskCommand(settings).execute(mock.interaction as any);
      assert(
        mock.deferred.length === 1 && mock.deferred[0] === undefined,
        "Successful guild /ask defers a PUBLIC reply with no ephemeral flag"
      );
      assert(
        mock.replies.length === 0 &&
          mock.edits.length === 1 &&
          mock.edits[0].content.includes("Shotbow Annihilation"),
        "Answer is sent through a public deferred interaction"
      );
      assert(
        mock.checks() >= 3 && requests.length === 1,
        "Fresh server membership checks are retained"
      );
      const serialized = JSON.stringify(requests[0]);
      assert(
        serialized.includes("Shotbow") &&
          serialized.includes("Annihilation") &&
          serialized.includes("FW"),
        "Community game context is included in the prompt"
      );
      assert(
        serialized.includes("docs/ai/organiser-game-ops.md") &&
          requests[0].tools.some(
            (tool: any) => tool.function.name === "get_organiser_status"
          ),
        "Organiser can discuss workflow and use role-gated tools in public channels"
      );
      assert(
        logs.length === 1 &&
          logs[0].includes("outcome=completed scope=guild") &&
          logs[0].includes("reply="),
        "Public final reply remains audited"
      );
    },
    () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content:
                  "FW is the community's competitive friendly war on Shotbow Annihilation.",
              },
            },
          ],
        }),
        { status: 200 }
      )
  );
});

test("Players can ask about organiser procedures publicly without receiving privileged tools", async () => {
  const mock = guildInteraction(
    "How do I announce a match with /announce start?",
    false
  );
  await withOfflineGroq(
    async (requests, logs) => {
      await new AskCommand(settings).execute(mock.interaction as any);
      assert(
        mock.deferred.length === 1 &&
          mock.deferred[0] === undefined &&
          mock.edits.length === 1,
        "A regular member can ask about organiser procedures in a public channel"
      );
      const payload = JSON.stringify(requests[0]);
      assert(
        payload.includes("docs/ai/organiser-game-ops.md") &&
          payload.includes("only authorised roles can perform"),
        "Approved organiser instructions are visible while execution remains role-restricted"
      );
      assert(
        requests[0].tools.every(
          (tool: any) =>
            tool.function.name !== "get_organiser_status" &&
            tool.function.name !== "get_game_diagnostics"
        ),
        "Organiser-only live tools are still withheld from ordinary players"
      );
      assert(
        mock.edits[0].content.includes("/announce start") &&
          logs[0]?.includes("outcome=completed scope=guild"),
        "The public response is delivered and logged"
      );
    },
    () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content:
                  "An organiser uses /announce start, reviews the preview and confirms it.",
              },
            },
          ],
        }),
        { status: 200 }
      )
  );
});

test("Invalid /ask questions still reply privately without AI network access", async () => {
  const mock = guildInteraction("BOT_TOKEN=do-not-post-secret", true);
  const dev = ConfigManager.getConfig().dev;
  const previous = dev.enabled;
  try {
    dev.enabled = false;
    await new AskCommand(settings).execute(mock.interaction as any);
    assert(
      mock.deferred.length === 0 &&
        mock.edits.length === 0 &&
        mock.replies.length === 1 &&
        mock.replies[0].flags === MessageFlags.Ephemeral,
      "Sensitive invalid input is rejected ephemerally before public deferral"
    );
  } finally {
    dev.enabled = previous;
  }
});

test("Groq truncated completions are safely classified rather than logged as successful answers", async () => {
  const mock = guildInteraction("How does a FW match work?", false);
  await withOfflineGroq(
    async (requests, logs) => {
      await new AskCommand(settings).execute(mock.interaction as any);
      assert(
        mock.deferred.length === 1 && mock.deferred[0] === undefined,
        "Provider failures use the already public deferred reply"
      );
      assert(
        mock.edits.length === 1 &&
          mock.edits[0].content.includes("AI is unavailable right now"),
        "Truncated completion cannot masquerade as a verified answer"
      );
      assert(
        requests[0].max_completion_tokens === AI_DEFAULTS.maxOutputTokens &&
          AI_DEFAULTS.maxOutputTokens > 500,
        "Groq has more room for reasoning tokens without making visible text verbose"
      );
      assert(
        logs.length === 1 &&
          logs[0].includes("outcome=provider_failed") &&
          logs[0].includes("error_kind=invalid error_code=finish_length") &&
          !logs[0].includes("sensitive-model-text"),
        "Only sanitised error classifications are logged"
      );
    },
    () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "length",
              message: { content: "sensitive-model-text" },
            },
          ],
        }),
        { status: 200 }
      )
  );
});

test("HTTP provider failures log safe status codes without response bodies", async () => {
  const mock = guildInteraction("What happened in this match?", false);
  await withOfflineGroq(
    async (_requests, logs) => {
      await new AskCommand(settings).execute(mock.interaction as any);
      assert(
        mock.edits.length === 1 &&
          mock.edits[0].content.includes("AI is unavailable right now"),
        "Provider HTTP failures get a safe user message"
      );
      assert(
        logs.length === 1 &&
          logs[0].includes("outcome=provider_failed") &&
          logs[0].includes("error_kind=unavailable error_code=http_400") &&
          !logs[0].includes("secret-provider-error"),
        "Error logs contain status category, not raw provider response"
      );
    },
    () => new Response('{"error":"secret-provider-error"}', { status: 400 })
  );
});
