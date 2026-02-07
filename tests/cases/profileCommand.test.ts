import { MessageFlags } from "discord.js";
import { test } from "../framework/test";
import { assert } from "../framework/assert";
import ProfileCommand from "../../src/commands/ProfileCommand";
import ProfileEditCommand from "../../src/commands/ProfileEditCommand";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
} from "../framework/mocks";
import { PrismaUtils } from "../../src/util/PrismaUtils";
import { prismaClient } from "../../src/database/prismaClient";
import { ConfigManager } from "../../src/ConfigManager";

test("/profile shows profile data when available", async () => {
  const cmd = new ProfileCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origProfile = (prismaClient as any).profile;
  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      id: "P1",
      discordSnowflake: "U1",
      latestIGN: "KnownIgn",
    });
    (prismaClient as any).profile = {
      findUnique: async () => ({
        preferredName: "KnownIgn",
        pronouns: "HE_HIM",
        languages: ["ENGLISH", "GERMAN"],
        region: "EU",
        rank: "GOLD",
        preferredRoles: ["RUSHER"],
        proficientAtRoles: [],
        improveRoles: [],
        playstyles: ["CHILL"],
      }),
    };

    const i = createChatInputInteraction("U1", {
      strings: { name: "KnownIgn" },
    });
    await cmd.execute(i as any);
    const reply = i.replies.find((r: any) => r.type === "reply");
    assert(!!reply?.payload?.embeds, "Profile embed returned");
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).profile = origProfile;
  }
});

test("/profilecreate denied outside bot commands channel", async () => {
  const cmd = new ProfileEditCommand();
  const i = createChatInputInteraction("U2", { channelId: "not-bot" }) as any;
  i.inGuild = () => true;
  i.guild = new FakeGuild();
  await cmd.execute(i);
  const reply = i.replies.find((r: any) => r.type === "reply");
  assert(
    !!reply && /bot commands/i.test(String(reply.payload?.content)),
    "Blocked outside bot commands"
  );
});

test("/profilecreate allowed in DMs", async () => {
  const cmd = new ProfileEditCommand();
  const i = createChatInputInteraction("U2") as any;
  i.inGuild = () => false;
  i.guild = null;
  const origFind = (PrismaUtils as any).findPlayer;
  const origProfile = (prismaClient as any).profile;
  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      id: "P2",
      discordSnowflake: "U2",
      latestIGN: "UserTwo",
    });
    (prismaClient as any).profile = {
      findUnique: async () => ({}),
      upsert: async () => ({}),
    };
    await cmd.execute(i);
    const reply = i.replies.find((r: any) => r.type === "reply");
    assert(!!reply && reply.payload?.embeds, "Allowed in DMs");
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).profile = origProfile;
  }
});

test("/profilecreate saves a section and /profile shows it", async () => {
  const edit = new ProfileEditCommand();
  const view = new ProfileCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origProfile = (prismaClient as any).profile;
  const store: any = {};
  const cfg = ConfigManager.getConfig();

  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      id: "P3",
      discordSnowflake: "U3",
      latestIGN: "PlayerThree",
    });
    (prismaClient as any).profile = {
      findUnique: async ({ where }: any) => store[where.playerId] ?? null,
      upsert: async ({ where, update, create }: any) => {
        store[where.playerId] = {
          ...(store[where.playerId] ?? {}),
          ...create,
          ...update,
        };
        return store[where.playerId];
      },
    };

    const guild = new FakeGuild() as any;
    const member = new FakeGuildMember("U3") as any;
    guild.addMember(member);

    const i = createChatInputInteraction("U3", {
      guild,
      channelId: cfg.channels.botCommands,
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    i.user.username = "UserThree";

    await edit.execute(i);

    const selectInteraction: any = {
      customId: "profile-select:pronouns",
      user: { id: "U3" },
      values: ["HE_HIM"],
      update: async (_payload: any) => ({}),
    };
    await edit.handleSelectMenu!(selectInteraction);

    const v = createChatInputInteraction("U3", {
      strings: { name: "PlayerThree" },
    });
    await view.execute(v as any);
    const reply = v.replies.find((r: any) => r.type === "reply");
    const fields = reply?.payload?.embeds?.[0]?.data?.fields ?? [];
    const pronouns = fields.find((f: any) => f.name === "Pronouns");
    assert(!!pronouns, "Pronouns saved and displayed");
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).profile = origProfile;
  }
});

test("/profilecreate clear removes section", async () => {
  const edit = new ProfileEditCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origProfile = (prismaClient as any).profile;
  const store: any = {
    P4: { pronouns: "SHE_HER" },
  };
  const cfg = ConfigManager.getConfig();

  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      id: "P4",
      discordSnowflake: "U4",
      latestIGN: "PlayerFour",
    });
    (prismaClient as any).profile = {
      findUnique: async ({ where }: any) => store[where.playerId] ?? null,
      upsert: async ({ where, update, create }: any) => {
        store[where.playerId] = {
          ...(store[where.playerId] ?? {}),
          ...create,
          ...update,
        };
        return store[where.playerId];
      },
    };

    const guild = new FakeGuild() as any;
    const member = new FakeGuildMember("U4") as any;
    guild.addMember(member);

    const i = createChatInputInteraction("U4", {
      guild,
      channelId: cfg.channels.botCommands,
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    i.user.username = "UserFour";

    await edit.execute(i);

    const clearInteraction: any = {
      customId: "profile-clear:pronouns",
      user: { id: "U4" },
      update: async (_payload: any) => ({}),
    };
    await edit.handleButtonPress(clearInteraction);

    assert(store.P4.pronouns === null, "Pronouns cleared");
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).profile = origProfile;
  }
});

test("/profilecreate blocks duplicate session", async () => {
  const edit = new ProfileEditCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origProfile = (prismaClient as any).profile;
  const cfg = ConfigManager.getConfig();

  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      id: "P5",
      discordSnowflake: "U5",
      latestIGN: "PlayerFive",
    });
    (prismaClient as any).profile = {
      findUnique: async () => null,
      upsert: async () => ({}),
    };

    const guild = new FakeGuild() as any;
    const member = new FakeGuildMember("U5") as any;
    guild.addMember(member);

    const i1 = createChatInputInteraction("U5", {
      guild,
      channelId: cfg.channels.botCommands,
    }) as any;
    i1.inGuild = () => true;
    i1.guild = guild;
    i1.user.username = "UserFive";

    const i2 = createChatInputInteraction("U5", {
      guild,
      channelId: cfg.channels.botCommands,
    }) as any;
    i2.inGuild = () => true;
    i2.guild = guild;
    i2.user.username = "UserFive";

    await edit.execute(i1);
    await edit.execute(i2);

    const reply = i2.replies.find((r: any) => r.type === "reply");
    assert(
      reply?.payload?.flags === MessageFlags.Ephemeral,
      "Duplicate session reply should be ephemeral"
    );
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).profile = origProfile;
  }
});

test("/profilecreate titles are locked by default", async () => {
  const edit = new ProfileEditCommand();
  const origFind = (PrismaUtils as any).findPlayer;
  const origProfile = (prismaClient as any).profile;
  const cfg = ConfigManager.getConfig();

  try {
    (PrismaUtils as any).findPlayer = async (_id: string) => ({
      id: "P6",
      discordSnowflake: "U6",
      latestIGN: "PlayerSix",
    });
    (prismaClient as any).profile = {
      findUnique: async () => null,
      upsert: async () => ({}),
    };

    const guild = new FakeGuild() as any;
    const member = new FakeGuildMember("U6") as any;
    guild.addMember(member);

    const i = createChatInputInteraction("U6", {
      guild,
      channelId: cfg.channels.botCommands,
    }) as any;
    i.inGuild = () => true;
    i.guild = guild;
    i.user.username = "UserSix";

    await edit.execute(i);

    const buttonInteraction: any = {
      customId: "profile-edit:title",
      user: { id: "U6" },
      update: async (payload: any) => {
        buttonInteraction.payload = payload;
        return {};
      },
    };
    await edit.handleButtonPress!(buttonInteraction);

    const menu = buttonInteraction.payload?.components?.[0]?.components?.[0];
    assert(menu?.disabled === true, "Title select menu is disabled by default");
  } finally {
    (PrismaUtils as any).findPlayer = origFind;
    (prismaClient as any).profile = origProfile;
  }
});
