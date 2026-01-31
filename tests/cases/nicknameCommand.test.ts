import { test } from "../framework/test";
import { assert } from "../framework/assert";
import NicknameCommand from "../../src/commands/NicknameCommand";
import { createChatInputInteraction, FakeGuild } from "../framework/mocks";
import { PrismaUtils } from "../../src/util/PrismaUtils";

test("/nickname ign sets nickname to latestIGN", async () => {
  const cmd = new NicknameCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const guild = new FakeGuild() as any;
  const member = guild.addMember({
    id: "U1",
    user: { tag: "user-U1" },
    setNickname: async (nick: string | null) => {
      (member as any).nickname = nick;
    },
  } as any);

  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      discordSnowflake: "U1",
      latestIGN: "LatestIgn",
    });

    const i = createChatInputInteraction("U1", {
      guild,
      strings: { action: "ign" },
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;

    await cmd.execute(i);

    assert(member.nickname === "LatestIgn", "Nickname set to latest IGN");
    const reply = i.replies.find((r: any) => r.type === "editReply");
    assert(!!reply, "Should edit reply with confirmation");
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
  }
});

test("/nickname clear clears nickname", async () => {
  const cmd = new NicknameCommand();
  const guild = new FakeGuild() as any;
  const member = guild.addMember({
    id: "U2",
    user: { tag: "user-U2" },
    nickname: "OldNick",
    setNickname: async (nick: string | null) => {
      (member as any).nickname = nick;
    },
  } as any);

  const i = createChatInputInteraction("U2", {
    guild,
    strings: { action: "clear" },
  }) as any;
  i.inGuild = () => true;
  i.guild = guild;

  await cmd.execute(i);

  assert(member.nickname === null, "Nickname cleared");
  const reply = i.replies.find((r: any) => r.type === "editReply");
  assert(!!reply, "Should edit reply with confirmation");
});
