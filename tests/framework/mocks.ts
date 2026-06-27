import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  Message,
  User,
} from "discord.js";

export class FakeRolesCache {
  private readonly roles = new Set<string>();
  has(id: string) {
    return this.roles.has(id);
  }
  async add(id: string) {
    this.roles.add(id);
  }
  async remove(id: string) {
    this.roles.delete(id);
  }
  toArray() {
    return Array.from(this.roles);
  }
}

export class FakeGuildMember {
  constructor(
    public id: string,
    initialRoles: string[] = []
  ) {
    for (const role of initialRoles) {
      void this.roles.cache.add(role);
    }
  }
  roles = {
    cache: new (class extends FakeRolesCache {})(),
    add: async (id: string) => this.roles.cache.add(id),
    remove: async (id: string) => this.roles.cache.remove(id),
  };
  user = { tag: `user-${this.id}` } as any;
  voice = {
    channelId: null as string | null,
    channel: null as any,
    setChannel: async (channel: any) => {
      this.voice.channel = channel;
      this.voice.channelId =
        typeof channel === "string" ? channel : (channel?.id ?? null);
    },
  };
}

export class FakeVoiceChannel {
  public deleted = false;
  public userLimit = 0;
  public parentId?: string;
  public permissionOverwrites = {
    cache: new Map<string, any>(),
    edit: async (id: string, overwrite: any) => {
      this.permissionOverwrites.cache.set(id, {
        ...(this.permissionOverwrites.cache.get(id) ?? {}),
        ...overwrite,
      });
    },
    delete: async (id: string) => {
      this.permissionOverwrites.cache.delete(id);
    },
  };

  constructor(
    public id: string,
    public name: string
  ) {}

  isVoiceBased() {
    return true;
  }

  async setUserLimit(limit: number) {
    this.userLimit = limit;
  }

  async delete() {
    this.deleted = true;
  }
}

export class FakeGuild {
  id = "guild-1";
  roles = { everyone: { id: this.id } } as any;
  members = {
    fetch: async (id: string) => this._members.get(id)!,
    cache: { get: (id: string) => this._members.get(id)! },
  } as any;
  private _members = new Map<string, FakeGuildMember>();
  private _channels = new Map<string, FakeVoiceChannel>();
  channels = {
    cache: { get: (id: string) => this._channels.get(id) as any },
    fetch: async (id: string) => (this._channels.get(id) as any) ?? null,
    create: async (options: any) => {
      const channel = new FakeVoiceChannel(
        `vc-${this._channels.size + 1}`,
        options.name
      );
      channel.parentId = options.parent;
      channel.userLimit = options.userLimit ?? 0;
      for (const overwrite of options.permissionOverwrites ?? []) {
        channel.permissionOverwrites.cache.set(overwrite.id, overwrite);
      }
      this._channels.set(channel.id, channel);
      return channel as any;
    },
  } as any;
  addMember(member: FakeGuildMember) {
    this._members.set(member.id, member);
    return member;
  }
  addChannel(channel: FakeVoiceChannel) {
    this._channels.set(channel.id, channel);
    return channel;
  }
}

type ChatOptions = {
  subcommand?: string;
  strings?: Record<string, string | null>;
  integers?: Record<string, number | null>;
  booleans?: Record<string, boolean | null>;
  users?: Record<string, Partial<User>>;
  channelId?: string;
  guild?: Guild;
  member?: any;
  channel?: any;
  commandName?: string;
};

export function createChatInputInteraction(
  userId: string,
  opts: ChatOptions = {}
): ChatInputCommandInteraction & { replies: any[] } {
  const replies: any[] = [];
  const fakeUser = {
    id: userId,
    username: `user-${userId}`,
    valueOf: () => userId,
  } as any;
  const options = {
    getSubcommand: (_required?: boolean) => opts.subcommand ?? "",
    getString: (name: string, _required?: boolean) =>
      opts.strings?.[name] ?? null,
    getInteger: (name: string, _required?: boolean) =>
      opts.integers?.[name] ?? null,
    getBoolean: (name: string, _required?: boolean) =>
      opts.booleans?.[name] ?? null,
    getUser: (name: string) =>
      opts.users?.[name] ? (opts.users[name] as any) : null,
    data: [],
  } as any;
  const interaction: any = {
    user: fakeUser,
    options,
    channel:
      opts.channel ??
      (opts.channelId ? ({ id: opts.channelId } as any) : undefined),
    channelId: opts.channelId,
    guild: opts.guild as any,
    member: opts.member,
    commandName: opts.commandName ?? "test",
    replied: false,
    deferred: false,
    replies,
    reply: (async (payload?: any) => {
      replies.push({ type: "reply", payload });
      interaction.replied = true;
      if (payload?.withResponse) {
        const messageId = `msg-${replies.length}`;
        return { resource: { message: { id: messageId } } } as any;
      }
      return {} as any;
    }) as any,
    editReply: (async (payload?: any) => {
      replies.push({ type: "editReply", payload });
      return {} as any;
    }) as any,
    deleteReply: (async () => {
      replies.push({ type: "deleteReply" });
      return {} as any;
    }) as any,
    deferReply: (async (_opts?: any) => {
      interaction.deferred = true;
      return {} as any;
    }) as any,
    isRepliable: () => true,
    isChatInputCommand: () => true,
    inGuild: () => Boolean(opts.guild),
  };
  return interaction as ChatInputCommandInteraction & { replies: any[] };
}

export function createButtonInteraction(
  customId: string,
  messageContent: string,
  clickerId: string,
  guild: Guild
): ButtonInteraction {
  const fakeUser = { id: clickerId, valueOf: () => clickerId } as any;
  const interaction: any = {
    customId,
    message: { content: messageContent } as Message,
    user: fakeUser,
    guild: guild as any,
    reply: (async (_opts?: any) => ({}) as any) as any,
    deferReply: (async (_opts?: any) => ({}) as any) as any,
    deferUpdate: (async (_opts?: any) => ({}) as any) as any,
  };
  return interaction as unknown as ButtonInteraction;
}
