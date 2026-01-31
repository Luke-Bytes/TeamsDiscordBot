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
  ) {}
  roles = {
    cache: new (class extends FakeRolesCache {})(),
    add: async (id: string) => this.roles.cache.add(id),
    remove: async (id: string) => this.roles.cache.remove(id),
  };
  user = { tag: `user-${this.id}` } as any;
}

export class FakeGuild {
  members = {
    fetch: async (id: string) => this._members.get(id)!,
    cache: { get: (id: string) => this._members.get(id)! },
  } as any;
  private _members = new Map<string, FakeGuildMember>();
  channels = { cache: { get: (_id: string) => undefined as any } } as any;
  addMember(member: FakeGuildMember) {
    this._members.set(member.id, member);
    return member;
  }
}

type ChatOptions = {
  subcommand?: string;
  strings?: Record<string, string | null>;
  users?: Record<string, Partial<User>>;
  channelId?: string;
  guild?: Guild;
  member?: any;
  channel?: any;
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
    getBoolean: (name: string, _required?: boolean) =>
      (opts.strings?.[name] as any) ?? null,
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
    replied: false,
    deferred: false,
    replies,
    reply: (async (payload?: any) => {
      replies.push({ type: "reply", payload });
      interaction.replied = true;
      return {} as any;
    }) as any,
    editReply: (async (payload?: any) => {
      replies.push({ type: "editReply", payload });
      return {} as any;
    }) as any,
    fetchReply: (async () => {
      return { id: `msg-${replies.length}` } as any;
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
