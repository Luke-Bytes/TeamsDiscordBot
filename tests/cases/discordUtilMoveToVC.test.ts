import { test } from "../framework/test";
import { assert } from "../framework/assert";
import { DiscordUtil } from "../../src/util/DiscordUtil";

function createGuildWithVoiceChannel(vcId: string) {
  const voiceChannel = {
    id: vcId,
    name: "Target VC",
    isVoiceBased: () => true,
  } as any;

  return {
    channels: {
      cache: { get: (id: string) => (id === vcId ? voiceChannel : undefined) },
    },
  } as any;
}

test("DiscordUtil.moveToVC skips when member not connected to voice", async () => {
  const guild = createGuildWithVoiceChannel("vc-1");
  let setCalled = false;

  const member: any = {
    user: { tag: "user-1" },
    voice: {
      channelId: undefined,
      setChannel: async () => {
        setCalled = true;
      },
    },
  };

  await DiscordUtil.moveToVC(guild, "vc-1", "role-1", "user-1", member);
  assert(!setCalled, "Should not attempt to move when not in voice");
});

test("DiscordUtil.moveToVC moves when member connected", async () => {
  const guild = createGuildWithVoiceChannel("vc-1");
  let setCalled = false;

  const member: any = {
    user: { tag: "user-2" },
    voice: {
      channelId: "vc-old",
      setChannel: async (channel: any) => {
        setCalled = channel?.id === "vc-1";
      },
    },
  };

  await DiscordUtil.moveToVC(guild, "vc-1", "role-1", "user-2", member);
  assert(setCalled, "Should move when connected to voice");
});
