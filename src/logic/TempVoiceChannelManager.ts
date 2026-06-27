import {
  ChannelType,
  Client,
  Guild,
  PermissionFlagsBits,
  VoiceChannel,
} from "discord.js";
import { prismaClient } from "../database/prismaClient";
import { ConfigManager } from "../ConfigManager";

export type TemporaryVoiceChannelRecord = {
  id?: string;
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

type TemporaryVoiceChannelDelegate = {
  findFirst(args: unknown): Promise<TemporaryVoiceChannelRecord | null>;
  findUnique?(args: unknown): Promise<TemporaryVoiceChannelRecord | null>;
  findMany(args?: unknown): Promise<TemporaryVoiceChannelRecord[]>;
  create(args: unknown): Promise<TemporaryVoiceChannelRecord>;
  update(args: unknown): Promise<TemporaryVoiceChannelRecord>;
  delete(args: unknown): Promise<TemporaryVoiceChannelRecord>;
};

export type CreateTempVoiceOptions = {
  guild: Guild;
  ownerId: string;
  name: string;
  userLimit?: number | null;
  private?: boolean;
  autoLockMinutes?: number | null;
  now?: Date;
};

export type CreateTempVoiceResult =
  | { ok: true; record: TemporaryVoiceChannelRecord; channel: VoiceChannel }
  | { ok: false; reason: "exists"; record: TemporaryVoiceChannelRecord }
  | { ok: false; reason: "missing_category" };

const EXPIRY_MS = 12 * 60 * 60 * 1000;

export class TempVoiceChannelManager {
  public static readonly expiryMs = EXPIRY_MS;

  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly autoLockTimers = new Map<string, NodeJS.Timeout>();

  public async create(
    options: CreateTempVoiceOptions
  ): Promise<CreateTempVoiceResult> {
    const categoryId =
      ConfigManager.getConfig().channels.temporaryVoiceCategory;
    if (!categoryId) return { ok: false, reason: "missing_category" };

    const existing = await this.findByOwner(options.guild.id, options.ownerId);
    if (existing) return { ok: false, reason: "exists", record: existing };

    const now = options.now ?? new Date();
    const expiresAt = new Date(now.getTime() + EXPIRY_MS);
    const autoLockAt = options.autoLockMinutes
      ? new Date(now.getTime() + options.autoLockMinutes * 60_000)
      : null;
    const permissionOverwrites = options.private
      ? [
          {
            id: this.everyoneRoleId(options.guild),
            deny: [PermissionFlagsBits.Connect],
          },
        ]
      : [];

    const channel = (await options.guild.channels.create({
      name: options.name,
      type: ChannelType.GuildVoice,
      parent: categoryId,
      userLimit: options.userLimit ?? undefined,
      permissionOverwrites,
    })) as VoiceChannel;

    const record = await this.delegate().create({
      data: {
        guildId: options.guild.id,
        channelId: channel.id,
        ownerId: options.ownerId,
        categoryId,
        name: options.name,
        createdAt: now,
        expiresAt,
        autoLockAt,
        locked: Boolean(options.private),
        invitedUserIds: [],
      },
    });

    this.schedule(record, options.guild);
    return { ok: true, record, channel };
  }

  public async recoverActiveChannels(client: Client): Promise<void> {
    const records = await this.delegate().findMany();
    const now = Date.now();
    for (const record of records) {
      const guild = await this.fetchGuild(client, record.guildId);
      if (!guild) {
        await this.deleteRecord(record);
        continue;
      }

      const channel = await this.fetchVoiceChannel(guild, record.channelId);
      if (!channel || record.expiresAt.getTime() <= now) {
        await this.deleteRecord(record, guild);
        continue;
      }

      this.schedule(record, guild);
    }
  }

  public async deleteForOwner(
    guild: Guild,
    ownerId: string
  ): Promise<TemporaryVoiceChannelRecord | null> {
    const record = await this.findByOwner(guild.id, ownerId);
    if (!record) return null;
    await this.deleteRecord(record, guild);
    return record;
  }

  public async findByOwner(
    guildId: string,
    ownerId: string
  ): Promise<TemporaryVoiceChannelRecord | null> {
    return this.delegate().findFirst({ where: { guildId, ownerId } });
  }

  public async lock(record: TemporaryVoiceChannelRecord, guild: Guild) {
    const channel = await this.requireVoiceChannel(guild, record.channelId);
    await channel.permissionOverwrites.edit(this.everyoneRoleId(guild), {
      Connect: false,
    });
    return this.delegate().update({
      where: { channelId: record.channelId },
      data: { locked: true },
    });
  }

  public async unlock(record: TemporaryVoiceChannelRecord, guild: Guild) {
    const channel = await this.requireVoiceChannel(guild, record.channelId);
    await channel.permissionOverwrites.edit(this.everyoneRoleId(guild), {
      Connect: null,
    });
    return this.delegate().update({
      where: { channelId: record.channelId },
      data: { locked: false },
    });
  }

  public async addUsers(
    record: TemporaryVoiceChannelRecord,
    guild: Guild,
    userIds: string[]
  ) {
    const channel = await this.requireVoiceChannel(guild, record.channelId);
    for (const userId of userIds) {
      await channel.permissionOverwrites.edit(userId, {
        ViewChannel: true,
        Connect: true,
      });
    }
    const invitedUserIds = Array.from(
      new Set([...record.invitedUserIds, ...userIds])
    );
    return this.delegate().update({
      where: { channelId: record.channelId },
      data: { invitedUserIds },
    });
  }

  public async removeUsers(
    record: TemporaryVoiceChannelRecord,
    guild: Guild,
    userIds: string[]
  ): Promise<{ record: TemporaryVoiceChannelRecord; disconnected: string[] }> {
    const channel = await this.requireVoiceChannel(guild, record.channelId);
    for (const userId of userIds) {
      await channel.permissionOverwrites.delete(userId).catch(() => undefined);
    }

    const disconnected: string[] = [];
    for (const userId of userIds) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member?.voice?.channelId === record.channelId) {
        await member.voice.setChannel(null).catch(() => undefined);
        disconnected.push(userId);
      }
    }

    const removeSet = new Set(userIds);
    const updated = await this.delegate().update({
      where: { channelId: record.channelId },
      data: {
        invitedUserIds: record.invitedUserIds.filter(
          (id) => !removeSet.has(id)
        ),
      },
    });
    return { record: updated, disconnected };
  }

  public async setUserLimit(
    record: TemporaryVoiceChannelRecord,
    guild: Guild,
    userLimit: number
  ) {
    const channel = await this.requireVoiceChannel(guild, record.channelId);
    await channel.setUserLimit(userLimit);
  }

  public async getVoiceChannel(
    guild: Guild,
    record: TemporaryVoiceChannelRecord
  ): Promise<VoiceChannel | null> {
    return this.fetchVoiceChannel(guild, record.channelId);
  }

  public getScheduledExpiryDelay(channelId: string): number | null {
    const timer = this.timers.get(channelId);
    return timer ? Number(timer._idleTimeout) : null;
  }

  private schedule(record: TemporaryVoiceChannelRecord, guild: Guild) {
    this.clearTimers(record.channelId);
    const expiresIn = Math.max(0, record.expiresAt.getTime() - Date.now());
    const expiryTimer = setTimeout(() => {
      void this.deleteRecord(record, guild);
    }, expiresIn);
    expiryTimer.unref?.();
    this.timers.set(record.channelId, expiryTimer);

    if (
      record.autoLockAt &&
      !record.locked &&
      record.autoLockAt.getTime() > Date.now()
    ) {
      const autoLockTimer = setTimeout(() => {
        void this.findByOwner(record.guildId, record.ownerId).then(
          async (latest) => {
            if (latest && !latest.locked) {
              await this.lock(latest, guild);
            }
          }
        );
      }, record.autoLockAt.getTime() - Date.now());
      autoLockTimer.unref?.();
      this.autoLockTimers.set(record.channelId, autoLockTimer);
    }
  }

  private async deleteRecord(
    record: TemporaryVoiceChannelRecord,
    guild?: Guild
  ): Promise<void> {
    this.clearTimers(record.channelId);
    const channel = guild
      ? await this.fetchVoiceChannel(guild, record.channelId)
      : null;
    await channel?.delete().catch(() => undefined);
    await this.delegate()
      .delete({ where: { channelId: record.channelId } })
      .catch(() => undefined);
  }

  private clearTimers(channelId: string) {
    const expiryTimer = this.timers.get(channelId);
    if (expiryTimer) clearTimeout(expiryTimer);
    this.timers.delete(channelId);

    const autoLockTimer = this.autoLockTimers.get(channelId);
    if (autoLockTimer) clearTimeout(autoLockTimer);
    this.autoLockTimers.delete(channelId);
  }

  private async requireVoiceChannel(
    guild: Guild,
    channelId: string
  ): Promise<VoiceChannel> {
    const channel = await this.fetchVoiceChannel(guild, channelId);
    if (!channel) {
      throw new Error(`Temporary voice channel ${channelId} was not found.`);
    }
    return channel;
  }

  private async fetchVoiceChannel(
    guild: Guild,
    channelId: string
  ): Promise<VoiceChannel | null> {
    const cached = guild.channels.cache.get(channelId);
    if (cached?.isVoiceBased()) return cached as VoiceChannel;
    const fetched = await guild.channels.fetch?.(channelId).catch(() => null);
    if (fetched?.isVoiceBased()) return fetched as VoiceChannel;
    return null;
  }

  private async fetchGuild(
    client: Client,
    guildId: string
  ): Promise<Guild | null> {
    const cached = client.guilds.cache.get(guildId);
    if (cached) return cached;
    return client.guilds.fetch(guildId).catch(() => null);
  }

  private everyoneRoleId(guild: Guild): string {
    return guild.roles.everyone?.id ?? guild.id;
  }

  private delegate(): TemporaryVoiceChannelDelegate {
    return (
      prismaClient as unknown as {
        temporaryVoiceChannel: TemporaryVoiceChannelDelegate;
      }
    ).temporaryVoiceChannel;
  }
}
