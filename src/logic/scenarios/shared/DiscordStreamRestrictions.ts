import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild, type VoiceChannel } from "discord.js";

const P = PermissionFlagsBits;
interface StreamReceipt {
  channelId: string;
  memberId: string;
  prior: true | false | null;
  hadOverwrite: boolean;
  uncertain: boolean;
}
export interface StreamTeam {
  channelId: string;
  memberIds: readonly string[];
}

/** Match-local member-level Video denies, without changing global roles or other permission bits. */
export class DiscordStreamRestrictions {
  private readonly receipts: StreamReceipt[] = [];
  constructor(
    private readonly guild: Guild,
    private readonly token: string,
    private readonly current: () => boolean,
    private readonly moderationConflict: (memberId: string) => boolean
  ) {}

  private async channel(id: string): Promise<VoiceChannel> {
    const channel = await this.guild.channels.fetch(id, { force: true });
    if (channel?.type !== ChannelType.GuildVoice) throw new Error("Scenario team voice channel unavailable.");
    return channel;
  }

  private log(receipt: StreamReceipt, status: string): void {
    console.info(`event=scenario.stream match=${this.token} channel=${receipt.channelId} member=${receipt.memberId} prior=${receipt.prior} status=${status}`);
  }

  async enforce(teams: readonly StreamTeam[]): Promise<void> {
    if (this.receipts.length) throw new Error("Previous screenshare changes still require cleanup.");
    for (const team of teams) {
      const channel = await this.channel(team.channelId);
      const bot = this.guild.members.me;
      if (!bot || !channel.permissionsFor(bot)?.has([P.ManageRoles, P.ManageChannels, P.MuteMembers, P.DeafenMembers, P.MoveMembers, P.Connect]) ||
          (channel.parent && !channel.parent.permissionsFor(bot)?.has(P.ManageChannels)))
        throw new Error("Scenario voice permissions are incomplete.");
      for (const memberId of team.memberIds) {
        const member = await this.guild.members.fetch({ user: memberId, force: true });
        const fresh = await this.channel(team.channelId);
        const effective = fresh.permissionsFor(member);
        if (!effective?.has([P.ViewChannel, P.Connect]) || member.permissions.has(P.Administrator) ||
            member.id === this.guild.ownerId || !this.current() || this.moderationConflict(memberId))
          throw new Error("Scenario voice or privileged-member permissions need organiser review.");
        if (member.voice.streaming) throw new Error("Ask players to stop active screenshares before starting.");
        if (!effective.has(P.Stream)) continue;
        const overwrite = fresh.permissionOverwrites.cache.get(memberId);
        if (overwrite && overwrite.type !== OverwriteType.Member)
          throw new Error("Unexpected member permission overwrite.");
        const prior = overwrite?.allow.has(P.Stream) ? true : overwrite?.deny.has(P.Stream) ? false : null;
        const receipt: StreamReceipt = {
          channelId: fresh.id, memberId, prior, hadOverwrite: !!overwrite, uncertain: true,
        };
        this.receipts.push(receipt);
        this.log(receipt, "intent");
        if (!this.current()) throw new Error("Scenario has changed.");
        await fresh.permissionOverwrites.edit(member, { Stream: false }, { reason: "Friendly Wars scenario - temporary no screenshare" });
        receipt.uncertain = false;
        this.log(receipt, "applied");
        const confirmed = await this.channel(fresh.id);
        if (confirmed.permissionsFor(member)?.has(P.Stream) !== false)
          throw new Error("Screenshare denial could not be verified.");
      }
    }
  }

  async verify(teams: readonly StreamTeam[]): Promise<void> {
    for (const team of teams) {
      const channel = await this.channel(team.channelId);
      for (const memberId of team.memberIds) {
        const member = await this.guild.members.fetch({ user: memberId, force: true });
        if (channel.permissionsFor(member)?.has(P.Stream) !== false || member.voice.streaming)
          throw new Error("Team screenshare restriction is not effective.");
      }
    }
  }

  /** Returns actionable IDs; failed/uncertain receipts are retained, not retried blindly. */
  async restore(): Promise<string[]> {
    const unresolved: StreamReceipt[] = [];
    for (const receipt of this.receipts) {
      try {
        if (receipt.uncertain || this.moderationConflict(receipt.memberId)) throw new Error("Ownership uncertain");
        const channel = await this.channel(receipt.channelId);
        const overwrite = channel.permissionOverwrites.cache.get(receipt.memberId);
        if (overwrite?.deny.has(P.Stream)) {
          const member = await this.guild.members.fetch({ user: receipt.memberId, force: true });
          if (!receipt.hadOverwrite && overwrite.allow.bitfield === 0n && overwrite.deny.bitfield === P.Stream) {
            await channel.permissionOverwrites.delete(member, "Friendly Wars scenario ended");
          } else {
            await channel.permissionOverwrites.edit(member, { Stream: receipt.prior }, { reason: "Friendly Wars scenario ended" });
          }
        }
        this.log(receipt, "restored");
      } catch {
        receipt.uncertain = true;
        unresolved.push(receipt);
        this.log(receipt, "unresolved");
      }
    }
    this.receipts.splice(0, this.receipts.length, ...unresolved);
    return unresolved.map((r) => `${r.channelId}/${r.memberId}`);
  }

  /** Only after authenticated organiser reconciliation. */
  acknowledgeManualCleanup(): void {
    this.receipts.length = 0;
  }
}
