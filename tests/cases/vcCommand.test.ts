import { CommandHandler } from "../../src/commands/CommandHandler";
import VcCommand from "../../src/commands/VcCommand";
import { prismaClient } from "../../src/database/prismaClient";
import { TempVoiceChannelManager } from "../../src/logic/TempVoiceChannelManager";
import { ConfigManager } from "../../src/ConfigManager";
import { InteractionGuard } from "../../src/util/InteractionGuard";
import { test } from "../framework/test";
import { assert, assertEqual } from "../framework/assert";
import {
  createChatInputInteraction,
  FakeGuild,
  FakeGuildMember,
  FakeVoiceChannel,
} from "../framework/mocks";
import { ApplicationCommandOptionType } from "discord.js";

type StoreRecord = {
  id: string;
  guildId: string;
  channelId: string;
  ownerId: string;
  categoryId: string;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  autoLockAt?: Date | null;
  locked: boolean;
  invitedUserIds: string[];
};

function configureChannels() {
  const config = ConfigManager.getConfig();
  config.channels.botCommands = "bot-commands";
  config.channels.temporaryVoiceCategory = "temp-category";
  config.roles.organiserRole = "organiser";
}

function setupTempStore(initial: StoreRecord[] = []) {
  const records = new Map(initial.map((record) => [record.channelId, record]));
  const originalTemp = (prismaClient as any).temporaryVoiceChannel;
  const originalPlayer = (prismaClient as any).player;
  const players = new Map<string, { discordSnowflake: string }>();

  (prismaClient as any).temporaryVoiceChannel = {
    findFirst: async ({ where }: any) =>
      Array.from(records.values()).find((record) =>
        Object.entries(where).every(
          ([key, value]) => record[key as keyof StoreRecord] === value
        )
      ) ?? null,
    findMany: async () => Array.from(records.values()),
    create: async ({ data }: any) => {
      const record = { ...data, id: `record-${records.size + 1}` };
      records.set(record.channelId, record);
      return record;
    },
    update: async ({ where, data }: any) => {
      const record = records.get(where.channelId);
      if (!record) throw new Error("record not found");
      const updated = { ...record, ...data };
      records.set(updated.channelId, updated);
      return updated;
    },
    delete: async ({ where }: any) => {
      const record = records.get(where.channelId);
      if (!record) throw new Error("record not found");
      records.delete(where.channelId);
      return record;
    },
  };

  (prismaClient as any).player = {
    ...originalPlayer,
    findFirst: async ({ where }: any) => {
      const identifier = where.OR[0].discordSnowflake;
      const latestIgn = where.OR[1].latestIGN.equals.toLowerCase();
      return players.get(identifier) ?? players.get(latestIgn) ?? null;
    },
  };

  return {
    records,
    players,
    restore: () => {
      (prismaClient as any).temporaryVoiceChannel = originalTemp;
      (prismaClient as any).player = originalPlayer;
    },
  };
}

function interaction(
  userId: string,
  options: Parameters<typeof createChatInputInteraction>[1]
) {
  return createChatInputInteraction(userId, {
    commandName: "vc",
    channelId: "bot-commands",
    ...options,
  });
}

test("Command registration includes /vc", async () => {
  const handler = new CommandHandler();
  handler.loadCommands();
  assert(
    handler.commands.some((command) => command.name === "vc"),
    "vc command should be loaded"
  );
});

test("/vc rejects usage outside botCommands", async () => {
  configureChannels();
  const cmd = new VcCommand();
  const guild = new FakeGuild() as any;
  const i = createChatInputInteraction("111111111111111111", {
    commandName: "vc",
    subcommand: "info",
    channelId: "elsewhere",
    guild,
  });

  await cmd.execute(i);
  assert(
    /bot commands channel/i.test(i.replies[0].payload.content),
    "should reject outside configured botCommands channel"
  );
});

test("/vc unsafe channel names are blocked by InteractionGuard", async () => {
  const guard = new InteractionGuard();
  const i = interaction("111111111111111111", {
    subcommand: "create",
  }) as any;
  i.options.data = [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "create",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "name",
          value: "@everyone temp",
        },
      ],
    },
  ];

  const ok = await guard.checkInputSafety(i);
  assert(!ok, "unsafe name should be blocked by existing guard");
});

test("/vc create enforces one channel per user and stores category plus 12h expiry", async () => {
  configureChannels();
  const store = setupTempStore();
  const cmd = new VcCommand();
  const guild = new FakeGuild() as any;

  try {
    const createdAt = Date.now();
    const i = interaction("111111111111111111", {
      subcommand: "create",
      guild,
      strings: { name: "My Squad" },
      integers: { "user-limit": 6, "auto-lock-minutes": 30 },
      booleans: { private: true },
    });
    await cmd.execute(i);

    const record = Array.from(store.records.values())[0];
    assertEqual(
      record.categoryId,
      "temp-category",
      "category should be stored"
    );
    assertEqual(record.name, "my-squad", "channel name should be normalized");
    assertEqual(record.locked, true, "private channel should start locked");
    assert(
      record.expiresAt.getTime() - createdAt <=
        TempVoiceChannelManager.expiryMs + 1000,
      "expiry should be 12h from creation"
    );
    assertEqual(
      cmd.manager.getScheduledExpiryDelay(record.channelId)! > 0,
      true,
      "expiry should be scheduled"
    );

    const second = interaction("111111111111111111", {
      subcommand: "create",
      guild,
      strings: { name: "Another" },
    });
    await cmd.execute(second);
    assert(
      /already own/i.test(second.replies[0].payload.content),
      "second create should be rejected"
    );
  } finally {
    store.restore();
  }
});

test("/vc delete removes channel and DB record", async () => {
  configureChannels();
  const store = setupTempStore();
  const cmd = new VcCommand();
  const guild = new FakeGuild() as any;

  try {
    const create = interaction("111111111111111111", {
      subcommand: "create",
      guild,
      strings: { name: "Delete Me" },
    });
    await cmd.execute(create);
    const channel = guild.channels.cache.get("vc-1") as FakeVoiceChannel;

    const del = interaction("111111111111111111", {
      subcommand: "delete",
      guild,
    });
    await cmd.execute(del);

    assert(channel.deleted, "Discord channel should be deleted");
    assertEqual(store.records.size, 0, "record should be deleted");
  } finally {
    store.restore();
  }
});

test("/vc lock and unlock update @everyone connect overwrite", async () => {
  configureChannels();
  const store = setupTempStore();
  const cmd = new VcCommand();
  const guild = new FakeGuild() as any;

  try {
    await cmd.execute(
      interaction("111111111111111111", {
        subcommand: "create",
        guild,
        strings: { name: "Lock Test" },
      })
    );
    const channel = guild.channels.cache.get("vc-1") as FakeVoiceChannel;

    await cmd.execute(
      interaction("111111111111111111", { subcommand: "lock", guild })
    );
    assertEqual(
      channel.permissionOverwrites.cache.get(guild.id).Connect,
      false,
      "lock should deny connect"
    );

    await cmd.execute(
      interaction("111111111111111111", { subcommand: "unlock", guild })
    );
    assertEqual(
      channel.permissionOverwrites.cache.get(guild.id).Connect,
      null,
      "unlock should remove connect deny"
    );
  } finally {
    store.restore();
  }
});

test("/vc add resolves mentions, IDs, and latest IGNs", async () => {
  configureChannels();
  const store = setupTempStore();
  const cmd = new VcCommand();
  const guild = new FakeGuild() as any;
  store.players.set("steve", { discordSnowflake: "333333333333333333" });

  try {
    await cmd.execute(
      interaction("111111111111111111", {
        subcommand: "create",
        guild,
        strings: { name: "Invite Test" },
      })
    );
    const addInteraction = interaction("111111111111111111", {
      subcommand: "add",
      guild,
      strings: {
        users: "<@222222222222222222> 444444444444444444 Steve missing-player",
      },
    });
    await cmd.execute(addInteraction);

    const record = Array.from(store.records.values())[0];
    assert(
      record.invitedUserIds.includes("222222222222222222"),
      "mention should resolve"
    );
    assert(
      record.invitedUserIds.includes("444444444444444444"),
      "raw ID should resolve"
    );
    assert(
      record.invitedUserIds.includes("333333333333333333"),
      "latest IGN should resolve"
    );
    assert(
      /missing-player/i.test(addInteraction.replies[0].payload.content),
      "unresolved user should be reported"
    );
  } finally {
    store.restore();
  }
});

test("/vc remove updates overwrites and disconnects users in the temp VC", async () => {
  configureChannels();
  const store = setupTempStore();
  const cmd = new VcCommand();
  const guild = new FakeGuild() as any;
  const member = guild.addMember(
    new FakeGuildMember("222222222222222222") as any
  ) as any;

  try {
    await cmd.execute(
      interaction("111111111111111111", {
        subcommand: "create",
        guild,
        strings: { name: "Remove Test" },
      })
    );
    await cmd.execute(
      interaction("111111111111111111", {
        subcommand: "add",
        guild,
        strings: { users: "222222222222222222" },
      })
    );
    member.voice.channelId = "vc-1";

    await cmd.execute(
      interaction("111111111111111111", {
        subcommand: "remove",
        guild,
        strings: { users: "222222222222222222" },
      })
    );

    const channel = guild.channels.cache.get("vc-1") as FakeVoiceChannel;
    const record = Array.from(store.records.values())[0];
    assert(
      !record.invitedUserIds.includes("222222222222222222"),
      "removed user should leave invited list"
    );
    assert(
      !channel.permissionOverwrites.cache.has("222222222222222222"),
      "explicit overwrite should be removed"
    );
    assertEqual(member.voice.channelId, null, "member should be disconnected");
  } finally {
    store.restore();
  }
});

test("startup recovery deletes expired channels and reschedules active ones", async () => {
  configureChannels();
  const expired: StoreRecord = {
    id: "expired",
    guildId: "guild-1",
    channelId: "expired-vc",
    ownerId: "111111111111111111",
    categoryId: "temp-category",
    name: "expired",
    createdAt: new Date(Date.now() - 20 * 60 * 60 * 1000),
    expiresAt: new Date(Date.now() - 1_000),
    autoLockAt: null,
    locked: false,
    invitedUserIds: [],
  };
  const active: StoreRecord = {
    id: "active",
    guildId: "guild-1",
    channelId: "active-vc",
    ownerId: "222222222222222222",
    categoryId: "temp-category",
    name: "active",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    autoLockAt: null,
    locked: false,
    invitedUserIds: [],
  };
  const store = setupTempStore([expired, active]);
  const manager = new TempVoiceChannelManager();
  const guild = new FakeGuild() as any;
  const expiredChannel = guild.addChannel(
    new FakeVoiceChannel("expired-vc", "expired")
  );
  guild.addChannel(new FakeVoiceChannel("active-vc", "active"));
  const client = {
    guilds: {
      cache: { get: (id: string) => (id === guild.id ? guild : undefined) },
      fetch: async () => guild,
    },
  } as any;

  try {
    await manager.recoverActiveChannels(client);
    assert(expiredChannel.deleted, "expired channel should be deleted");
    assert(
      !store.records.has("expired-vc"),
      "expired record should be deleted"
    );
    assert(
      manager.getScheduledExpiryDelay("active-vc")! > 0,
      "active record should be rescheduled"
    );
  } finally {
    store.restore();
  }
});
