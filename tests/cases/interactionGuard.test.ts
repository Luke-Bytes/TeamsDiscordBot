import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { InteractionGuard } from "../../src/util/InteractionGuard";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { ConfigManager } from "../../src/ConfigManager";
import { ApplicationCommandOptionType } from "discord.js";

function withMockedNow(times: number[], fn: () => void | Promise<void>) {
  const origNow = Date.now;
  let idx = 0;
  Date.now = () => times[Math.min(idx, times.length - 1)];
  return Promise.resolve(fn()).finally(() => {
    Date.now = origNow;
  });
}

test("Rate limit blocks 3 repeated uses of same command in 10s", async () => {
  const guard = new InteractionGuard();
  const i = createChatInputInteraction("U1");

  await withMockedNow([0, 3000, 6000, 9000], async () => {
    assert(await guard.checkRateLimit(i), "First allowed");
    assert(await guard.checkRateLimit(i), "Second allowed");
    assert(await guard.checkRateLimit(i), "Third allowed");
    const allowed = await guard.checkRateLimit(i);
    assert(!allowed, "Fourth blocked by repeated use rule");
  });
});

test("Rate limit escalates cooldown duration on repeated violations", async () => {
  const guard = new InteractionGuard();
  const i = createChatInputInteraction("U2");

  await withMockedNow(
    [
      0,
      3000,
      6000,
      9000, // violation 1
      12000,
      15000,
      18000,
      21000, // violation 2
    ],
    async () => {
      for (let n = 0; n < 4; n += 1) {
        await guard.checkRateLimit(i);
      }
      const firstBlock = await guard.checkRateLimit(i);
      assert(!firstBlock, "First cooldown applied");
      for (let n = 0; n < 4; n += 1) {
        await guard.checkRateLimit(i);
      }
      const secondBlock = await guard.checkRateLimit(i);
      assert(!secondBlock, "Cooldown escalated on repeated violation");
    }
  );
});

test("Organiser is exempt from rate limiting", async () => {
  const guard = new InteractionGuard();
  const cfg = ConfigManager.getConfig();
  const guild = new FakeGuild() as any;
  const member = new FakeGuildMember("ORG");
  await member.roles.add(cfg.roles.organiserRole);
  guild.addMember(member);

  const i = createChatInputInteraction("ORG", {
    guild,
    member: member as any,
  }) as any;
  i.inGuild = () => true;

  await withMockedNow([0, 100, 200, 300], async () => {
    assert(await guard.checkRateLimit(i), "Organiser allowed");
    assert(await guard.checkRateLimit(i), "Organiser allowed again");
    assert(await guard.checkRateLimit(i), "Organiser allowed again");
  });
});

test("Input filter blocks unsafe string options", async () => {
  const guard = new InteractionGuard();
  const i = createChatInputInteraction("U3") as any;
  i.isChatInputCommand = () => true;
  i.options = {
    data: [
      {
        type: ApplicationCommandOptionType.String,
        name: "reason",
        value: "you are a cunt",
      },
    ],
  } as any;

  const ok = await guard.checkInputSafety(i);
  assert(!ok, "Unsafe input rejected");
  const reply = i.replies.find((r: any) => r.type === "reply");
  assert(!!reply, "Replies with warning");
});

test("Input filter allows clean string options", async () => {
  const guard = new InteractionGuard();
  const i = createChatInputInteraction("U4") as any;
  i.isChatInputCommand = () => true;
  i.options = {
    data: [
      {
        type: ApplicationCommandOptionType.String,
        name: "note",
        value: "gg nice play",
      },
    ],
  } as any;

  const ok = await guard.checkInputSafety(i);
  assert(ok, "Safe input allowed");
});

test("Rate limit blocks too many unique commands in 15s", async () => {
  const guard = new InteractionGuard();
  const makeInteraction = (name: string) => {
    const i = createChatInputInteraction("U5") as any;
    i.isChatInputCommand = () => true;
    i.commandName = name;
    return i;
  };

  await withMockedNow([0, 2000, 4000, 6000, 8000, 10000], async () => {
    assert(await guard.checkRateLimit(makeInteraction("a")), "cmd a allowed");
    assert(await guard.checkRateLimit(makeInteraction("b")), "cmd b allowed");
    assert(await guard.checkRateLimit(makeInteraction("c")), "cmd c allowed");
    assert(await guard.checkRateLimit(makeInteraction("d")), "cmd d allowed");
    assert(await guard.checkRateLimit(makeInteraction("e")), "cmd e allowed");
    const blocked = await guard.checkRateLimit(makeInteraction("f"));
    assert(!blocked, "6th unique command blocked");
  });
});
