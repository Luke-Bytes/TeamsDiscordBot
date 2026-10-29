import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import { MojangAPI } from "../../src/api/MojangAPI";
import VerifyCommand from "../../src/commands/VerifyCommand";
import { DiscordUtil } from "../../src/util/DiscordUtil";
import { prismaClient } from "../../src/database/prismaClient";
import { FakeGuild, createChatInputInteraction } from "../framework/mocks";

// The legacy end-to-end tests replace this static method without restoring it.
// Capture the real implementation at module load, before the runner executes tests.
const realUsernameToUUID = MojangAPI.usernameToUUID;

test("Mojang 404 is a definite not-found without a third-party fallback", async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  (globalThis as any).fetch = async () => {
    calls++;
    return { status: 404, ok: false };
  };
  try {
    const result = await MojangAPI.lookupUsername("Missing404Name");
    assertEqual(result.status, "notFound", "Authoritative 404 means not found");
    assertEqual(calls, 1, "No third-party lookup after definitive Mojang 404");
  } finally {
    (globalThis as any).fetch = oldFetch;
  }
});

test("Mojang 429 followed by fallback 404 remains unavailable", async () => {
  const oldFetch = globalThis.fetch;
  let primary = 0;
  (globalThis as any).fetch = async (input: string) => {
    if (String(input).includes("api.mojang.com")) {
      primary++;
      return { status: 429, ok: false, headers: { get: () => "0" } };
    }
    return { status: 404, ok: false };
  };
  try {
    const result = await MojangAPI.lookupUsername("Outage429Name");
    assertEqual(primary, 2, "Transient status should retry once");
    assertEqual(result.status, "unavailable", "Third-party miss does not prove absence");
  } finally {
    (globalThis as any).fetch = oldFetch;
  }
});

test("Mojang timeout and fallback failure never return a UUID", async () => {
  const oldFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => { throw new Error("offline"); };
  try {
    const result = await MojangAPI.lookupUsername("TimeoutName");
    assertEqual(result.status, "unavailable", "Network failure must stay unknown");
    assertEqual(await realUsernameToUUID.call(MojangAPI, "TimeoutName"), null,
      "Registration compatibility API should never invent a UUID");
  } finally {
    (globalThis as any).fetch = oldFetch;
  }
});

test("verification does not ping a departed registered Minecraft account", async () => {
  const oldGet = DiscordUtil.getGuildMember;
  const oldLookup = MojangAPI.lookupUsername;
  const oldFind = prismaClient.player.findFirst;
  (DiscordUtil as any).getGuildMember = () => ({ roles: { cache: { has: () => true } } });
  (MojangAPI as any).lookupUsername = async () => ({
    status: "found", uuid: "0123456789abcdef0123456789abcdef"
  });
  (prismaClient.player as any).findFirst = async () => ({
    discordSnowflake: "12345", latestIGN: "Known"
  });
  try {
    const interaction = createChatInputInteraction("9000", {
      guild: new FakeGuild() as any,
      strings: { names: "Known" }, booleans: { pingplayers: true },
    });
    await new VerifyCommand().execute(interaction);
    const response: any = interaction.replies.find((r: any) => r.type === "editReply")?.payload;
    assert(response?.content.includes("no longer in server"),
      "Departed profile must be labelled correctly");
    assert(!response.content.includes("<@12345>"), "Departed user must not be mentioned");
    assertEqual(response.allowedMentions.users.length, 0, "No departed ping should be allowed");
  } finally {
    (DiscordUtil as any).getGuildMember = oldGet;
    (MojangAPI as any).lookupUsername = oldLookup;
    (prismaClient.player as any).findFirst = oldFind;
  }
});
