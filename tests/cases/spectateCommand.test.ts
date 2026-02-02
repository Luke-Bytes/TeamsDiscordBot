import { test } from "../framework/test";
import { assert } from "../framework/assert";
import SpectateCommand from "../../src/commands/SpectateCommand";
import { createChatInputInteraction } from "../framework/mocks";
import { ConfigManager } from "../../src/ConfigManager";
import { PermissionsUtil } from "../../src/util/PermissionsUtil";

type FakeMember = {
  id: string;
  user: { id: string; tag: string; send?: any };
  roles: { cache: { has: (id: string) => boolean }; add: any; remove: any };
  voice: {
    channel?: { id: string };
    setMute: (v: boolean) => Promise<void>;
    setDeaf: (v: boolean) => Promise<void>;
    setChannel: (id: string) => Promise<void>;
  };
};

const ROLE_IDS = {
  captain: "role-captain",
  clan: "role-clan",
  spectator: "role-spectator",
};

function makeMember(id: string, roles: string[], vcId?: string): FakeMember {
  const roleSet = new Set(roles);
  const member: FakeMember = {
    id,
    user: { id, tag: `user-${id}` },
    roles: {
      cache: { has: (roleId: string) => roleSet.has(roleId) },
      add: async (roleId: string) => roleSet.add(roleId),
      remove: async (roleId: string) => roleSet.delete(roleId),
    },
    voice: {
      channel: vcId ? { id: vcId } : undefined,
      setMute: async (_v: boolean) => {},
      setDeaf: async (_v: boolean) => {},
      setChannel: async (newId: string) => {
        member.voice.channel = { id: newId };
      },
    },
  };
  return member;
}

function makeGuild(members: FakeMember[]) {
  const map = new Map(members.map((m) => [m.id, m]));
  return {
    members: {
      fetch: async (id: string) => map.get(id) ?? null,
      cache: { get: (id: string) => map.get(id) ?? null },
    },
  } as any;
}

function withConfig<T>(fn: () => Promise<T>) {
  const orig = ConfigManager.getConfig.bind(ConfigManager);
  const origPermRoles = { ...(PermissionsUtil as any).config.roles };
  (ConfigManager as any).getConfig = () => ({
    ...orig(),
    roles: {
      ...orig().roles,
      captainRole: ROLE_IDS.captain,
      clanLeaderRole: ROLE_IDS.clan,
      spectatorRole: ROLE_IDS.spectator,
    },
  });
  (PermissionsUtil as any).config.roles = {
    ...(PermissionsUtil as any).config.roles,
    captainRole: ROLE_IDS.captain,
    clanLeaderRole: ROLE_IDS.clan,
    spectatorRole: ROLE_IDS.spectator,
  };
  return fn().finally(() => {
    (ConfigManager as any).getConfig = orig;
    (PermissionsUtil as any).config.roles = origPermRoles;
  });
}

test("/spectate request sends DM and stores pending", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const target = makeMember("T1", [ROLE_IDS.captain], "vc-1");
    let dmPayload: any;
    target.user.send = async (payload: any) => {
      dmPayload = payload;
      return {};
    };
    const requester = makeMember("U1", [], "vc-x");
    const guild = makeGuild([target, requester]);

    const i = createChatInputInteraction("U1", {
      guild,
      strings: { action: "request" },
      users: { user: { id: "T1", tag: "user-T1" } as any },
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    i.user.tag = "user-U1";

    await cmd.execute(i);
    assert(!!dmPayload?.components, "DM sent with buttons");
    assert(
      i.replies.some((r: any) => r.type === "reply"),
      "Request replied"
    );
  });
});

test("/spectate request rejects non captain/clan leader", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const target = makeMember("T2", [], "vc-1");
    target.user.send = async () => ({});
    const guild = makeGuild([target, makeMember("U2", [])]);
    const i = createChatInputInteraction("U2", {
      guild,
      strings: { action: "request" },
      users: { user: { id: "T2", tag: "user-T2" } as any },
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    await cmd.execute(i);
    const reply = i.replies.find((r: any) => r.type === "reply");
    assert(
      String(reply?.payload?.content || "").includes("not a captain"),
      "Rejects invalid target"
    );
  });
});

test("/spectate request rejects when target not in VC", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const target = makeMember("T3", [ROLE_IDS.clan]);
    target.user.send = async () => ({});
    const guild = makeGuild([target, makeMember("U3", [])]);
    const i = createChatInputInteraction("U3", {
      guild,
      strings: { action: "request" },
      users: { user: { id: "T3", tag: "user-T3" } as any },
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    await cmd.execute(i);
    const reply = i.replies.find((r: any) => r.type === "reply");
    assert(
      String(reply?.payload?.content || "").includes("must be in a voice"),
      "Rejects when target not in VC"
    );
  });
});

test("/spectate request handles DM failure", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const target = makeMember("T4", [ROLE_IDS.captain], "vc-1");
    target.user.send = async () => {
      throw new Error("DM closed");
    };
    const guild = makeGuild([target, makeMember("U4", [])]);
    const i = createChatInputInteraction("U4", {
      guild,
      strings: { action: "request" },
      users: { user: { id: "T4", tag: "user-T4" } as any },
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    i.user.tag = "user-U4";
    await cmd.execute(i);
    const reply = i.replies.find((r: any) => r.type === "reply");
    assert(
      String(reply?.payload?.content || "").includes("Couldn't DM"),
      "DM failure guidance"
    );
  });
});

test("/spectate allow rejects non captain/clan leader", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const guild = makeGuild([makeMember("U5", [])]);
    const i = createChatInputInteraction("U5", {
      guild,
      strings: { action: "allow" },
      users: { user: { id: "REQ", tag: "user-REQ" } as any },
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    await cmd.execute(i);
    const reply = i.replies.find((r: any) => r.type === "reply");
    assert(
      String(reply?.payload?.content || "").includes("Only captains"),
      "Rejects non-captain allow"
    );
  });
});

test("/spectate allow rejects without pending request", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const captain = makeMember("CAP", [ROLE_IDS.captain], "vc-1");
    const guild = makeGuild([captain]);
    const i = createChatInputInteraction("CAP", {
      guild,
      strings: { action: "allow" },
      users: { user: { id: "REQ", tag: "user-REQ" } as any },
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    await cmd.execute(i);
    const reply = i.replies.find((r: any) => r.type === "reply");
    assert(
      String(reply?.payload?.content || "").includes("No pending"),
      "Rejects missing request"
    );
  });
});

test("spectate accept button rejects wrong target", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const target = makeMember("T5", [ROLE_IDS.captain], "vc-1");
    const requester = makeMember("U6", [], "vc-x");
    const guild = makeGuild([target, requester]);
    const requestId = "REQ1";
    (cmd as any).pendingRequests.set(requestId, {
      requestId,
      requesterId: "U6",
      targetId: "T5",
      expiresAt: Date.now() + 10000,
    });

    const interaction: any = {
      customId: `spectate-accept:${requestId}`,
      user: { id: "OTHER" },
      guild,
      reply: async (payload: any) => {
        interaction.lastReply = payload;
        return payload;
      },
    };
    await cmd.handleButtonPress(interaction);
    assert(
      String(interaction.lastReply?.content || "").includes(
        "Only the requested"
      ),
      "Rejects wrong target"
    );
  });
});

test("spectate accept success assigns role and moves", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const target = makeMember("T6", [ROLE_IDS.captain], "vc-1");
    const requester = makeMember("U7", [], "vc-x");
    const guild = makeGuild([target, requester]);
    const requestId = "REQ2";
    (cmd as any).pendingRequests.set(requestId, {
      requestId,
      requesterId: "U7",
      targetId: "T6",
      expiresAt: Date.now() + 10000,
    });

    const interaction: any = {
      customId: `spectate-accept:${requestId}`,
      user: { id: "T6" },
      guild,
      reply: async (payload: any) => {
        interaction.lastReply = payload;
        return payload;
      },
    };
    await cmd.handleButtonPress(interaction);
    assert(
      requester.roles.cache.has(ROLE_IDS.spectator),
      "Spectator role assigned"
    );
    assert(
      requester.voice.channel?.id === "vc-1",
      "Requester moved to target channel"
    );
  });
});

test("spectate accept prompts rejoin when requester not in VC", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const target = makeMember("T7", [ROLE_IDS.captain], "vc-1");
    const requester = makeMember("U8", []);
    const guild = makeGuild([target, requester]);
    const requestId = "REQ3";
    (cmd as any).pendingRequests.set(requestId, {
      requestId,
      requesterId: "U8",
      targetId: "T7",
      expiresAt: Date.now() + 10000,
    });

    const interaction: any = {
      customId: `spectate-accept:${requestId}`,
      user: { id: "T7" },
      guild,
      reply: async (payload: any) => {
        interaction.lastReply = payload;
        return payload;
      },
    };
    await cmd.handleButtonPress(interaction);
    assert(
      String(interaction.lastReply?.content || "").includes("join any voice"),
      "Prompts rejoin"
    );
  });
});

test("/spectate rejoin works within window", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const requester = makeMember("U9", [], "vc-x");
    const guild = makeGuild([requester]);
    (cmd as any).activeSpectates.set("U9", {
      targetId: "T9",
      channelId: "vc-9",
      expiresAt: Date.now() + 60_000,
    });

    const i = createChatInputInteraction("U9", {
      guild,
      strings: { action: "rejoin" },
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    await cmd.execute(i);
    assert(requester.voice.channel?.id === "vc-9", "Rejoined target channel");
    assert(
      requester.roles.cache.has(ROLE_IDS.spectator),
      "Spectator role restored"
    );
  });
});

test("/spectate stop removes role and unmutes", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    let muted = true;
    let deaf = true;
    const requester = makeMember("U10", [ROLE_IDS.spectator], "vc-x");
    requester.voice.setMute = async (v: boolean) => {
      muted = v;
    };
    requester.voice.setDeaf = async (v: boolean) => {
      deaf = v;
    };
    const guild = makeGuild([requester]);
    const i = createChatInputInteraction("U10", {
      guild,
      strings: { action: "stop" },
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    await cmd.execute(i);
    assert(!requester.roles.cache.has(ROLE_IDS.spectator), "Role removed");
    assert(!muted && !deaf, "Unmuted and undeafened");
  });
});

test("Multiple requests handled without cross-contamination", async () => {
  await withConfig(async () => {
    const cmd = new SpectateCommand();
    const captain = makeMember("CAPX", [ROLE_IDS.captain], "vc-1");
    const r1 = makeMember("R1", [], "vc-a");
    const r2 = makeMember("R2", [], "vc-b");
    const r3 = makeMember("R3", [], "vc-c");
    const guild = makeGuild([captain, r1, r2, r3]);

    const id1 = "REQ-A";
    const id2 = "REQ-B";
    const id3 = "REQ-C";
    (cmd as any).pendingRequests.set(id1, {
      requestId: id1,
      requesterId: "R1",
      targetId: "CAPX",
      expiresAt: Date.now() + 10_000,
    });
    (cmd as any).pendingRequests.set(id2, {
      requestId: id2,
      requesterId: "R2",
      targetId: "CAPX",
      expiresAt: Date.now() + 10_000,
    });
    (cmd as any).pendingRequests.set(id3, {
      requestId: id3,
      requesterId: "R3",
      targetId: "CAPX",
      expiresAt: Date.now() + 10_000,
    });

    const accept = async (requestId: string) => {
      const interaction: any = {
        customId: `spectate-accept:${requestId}`,
        user: { id: "CAPX" },
        guild,
        reply: async (payload: any) => payload,
      };
      await cmd.handleButtonPress(interaction);
    };

    const deny = async (requestId: string) => {
      const interaction: any = {
        customId: `spectate-deny:${requestId}`,
        user: { id: "CAPX" },
        guild,
        reply: async (payload: any) => payload,
      };
      await cmd.handleButtonPress(interaction);
    };

    await accept(id1);
    await deny(id2);
    await accept(id3);

    assert(r1.roles.cache.has(ROLE_IDS.spectator), "First requester accepted");
    assert(!r2.roles.cache.has(ROLE_IDS.spectator), "Second requester denied");
    assert(r3.roles.cache.has(ROLE_IDS.spectator), "Third requester accepted");
    assert(
      r1.voice.channel?.id === "vc-1" &&
        r3.voice.channel?.id === "vc-1" &&
        r2.voice.channel?.id === "vc-b",
      "Only accepted users moved"
    );
  });
});
