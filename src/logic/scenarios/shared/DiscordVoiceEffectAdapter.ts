import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild, type GuildMember, type VoiceChannel } from "discord.js";
import type { VoiceChange, VoiceEffectAdapter, VoiceEffectRequest } from "./VoiceEffectService";
import type { VoiceParticipant } from "./VoiceEffects";

const P = PermissionFlagsBits;

/** Match-local adapter. Caller supplies current eligibility and moderation policy. */
export class DiscordVoiceEffectAdapter implements VoiceEffectAdapter {
  private readonly owned = new Set<string>();

  constructor(
    private readonly guild: Guild,
    private readonly token: string,
    private readonly eligible: (member: GuildMember, originalChannel: string) => boolean,
    private readonly moderationConflict: (memberId: string) => boolean
  ) {}

  private async member(id: string): Promise<GuildMember | null> {
    try { return await this.guild.members.fetch({ user: id, force: true }); }
    catch { return null; }
  }

  private async voiceChannel(id: string): Promise<VoiceChannel | null> {
    const channel = await this.guild.channels.fetch(id, { force: true }).catch(() => null);
    return channel?.type === ChannelType.GuildVoice ? channel : null;
  }

  async inspect(ids: readonly string[], originalChannel: string): Promise<VoiceParticipant[]> {
    const result: VoiceParticipant[] = [];
    for (const id of ids) {
      const member = await this.member(id);
      if (!member) continue;
      const voice = await this.guild.voiceStates.fetch(id, { force: true }).catch(() => null);
      if (!voice) continue;
      result.push({
        id, channelId: voice.channelId,
        eligible: !member.user.bot && member.manageable && !member.isCommunicationDisabled() &&
          this.eligible(member, originalChannel) && !this.moderationConflict(id),
        serverMute: voice.serverMute !== false,
        serverDeaf: voice.serverDeaf !== false,
      });
    }
    return result;
  }

  async createIsolation(request: VoiceEffectRequest, selected: readonly string[]): Promise<string> {
    const original = await this.voiceChannel(request.channelId);
    const bot = this.guild.members.me;
    if (request.token !== this.token || !original || !bot ||
        !original.permissionsFor(bot)?.has([P.ManageChannels, P.MoveMembers, P.ManageRoles]))
      throw new Error("Isolation permissions unavailable.");
    // Explicit overwrites (do not inherit category grants).
    console.info(`event=scenario.voice.channel match=${this.token} original=${original.id} status=intent`);
    const channel = await this.guild.channels.create({
      name: "Scenario - temporary team voice",
      type: ChannelType.GuildVoice,
      parent: original.parentId,
      permissionOverwrites: [
        { id: this.guild.id, type: OverwriteType.Role, deny: [P.ViewChannel, P.Connect, P.Stream] },
        { id: bot.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.Connect, P.ManageChannels, P.MoveMembers, P.ManageRoles] },
        ...selected.map((id) => ({
          id, type: OverwriteType.Member,
          allow: [P.ViewChannel, P.Connect, P.Speak],
          deny: [P.Stream],
        })),
      ],
      reason: "Friendly Wars temporary voice effect",
    });
    this.owned.add(channel.id);
    console.info(`event=scenario.voice.channel match=${this.token} channel=${channel.id} status=created`);
    return channel.id;
  }

  async apply(change: VoiceChange, canApply: () => boolean): Promise<"applied" | "skipped" | "uncertain"> {
    const member = await this.member(change.memberId);
    const bot = this.guild.members.me;
    const original = await this.voiceChannel(change.originalChannel);
    if (!member || !bot || !original || !member.manageable || member.user.bot ||
        member.isCommunicationDisabled() || !this.eligible(member, change.originalChannel) ||
        this.moderationConflict(member.id)) return "skipped";
    const voice = await this.guild.voiceStates.fetch(member.id, { force: true }).catch(() => null);
    if (!voice || voice.channelId !== original.id || voice.serverMute !== false || voice.serverDeaf !== false)
      return "skipped";
    const permission = change.operation === "mute" ? P.MuteMembers :
      change.operation === "deafen" ? P.DeafenMembers : P.MoveMembers;
    if (!original.permissionsFor(bot)?.has(permission)) return "skipped";
    if (change.operation === "move") {
      if (!change.destination || !this.owned.has(change.destination)) return "skipped";
      const target = await this.voiceChannel(change.destination);
      if (!target || !target.permissionsFor(bot)?.has([P.Connect, P.MoveMembers]) ||
          !target.permissionsFor(member)?.has([P.ViewChannel, P.Connect]) ||
          target.permissionsFor(member)?.has(P.Stream)) return "skipped";
    }
    if (!canApply() || !this.eligible(member, change.originalChannel) || this.moderationConflict(member.id))
      return "skipped";
    try {
      if (change.operation === "mute") await voice.setMute(true, "Friendly Wars temporary voice effect");
      else if (change.operation === "deafen") await voice.setDeaf(true, "Friendly Wars temporary voice effect");
      else await voice.setChannel(change.destination!, "Friendly Wars temporary voice effect");
      return "applied";
    } catch {
      // A failed REST acknowledgement does not establish ownership.
      return "uncertain";
    }
  }

  async restore(change: VoiceChange): Promise<"restored" | "unchanged" | "unresolved"> {
    const member = await this.member(change.memberId);
    if (!member || this.moderationConflict(change.memberId) || !member.manageable ||
        member.isCommunicationDisabled()) return "unresolved";
    const voice = await this.guild.voiceStates.fetch(member.id, { force: true }).catch(() => null);
    if (!voice?.channelId) return "unresolved";
    if (change.operation === "move") {
      if (voice.channelId !== change.destination) return "unchanged";
      if (!change.destination || !this.owned.has(change.destination) ||
          !this.eligible(member, change.originalChannel)) return "unresolved";
      const original = await this.voiceChannel(change.originalChannel);
      if (!original || !original.permissionsFor(member)?.has([P.ViewChannel, P.Connect]))
        return "unresolved";
      await voice.setChannel(original, "Friendly Wars temporary voice effect ended");
    } else {
      const set = change.operation === "mute" ? voice.serverMute : voice.serverDeaf;
      if (set === false) return "unchanged";
      if (set !== true || !this.eligible(member, change.originalChannel)) return "unresolved";
      // Same-value writes by moderators cannot be distinguished from this effect.
      if (change.operation === "mute") await voice.setMute(false, "Friendly Wars temporary voice effect ended");
      else await voice.setDeaf(false, "Friendly Wars temporary voice effect ended");
    }
    return "restored";
  }

  async removeIsolation(channelId: string): Promise<boolean> {
    if (!this.owned.has(channelId)) return false;
    const channel = await this.voiceChannel(channelId);
    // A failed channel fetch is not proof that the channel was deleted.
    if (!channel || channel.members.size) return false;
    await channel.delete("Friendly Wars temporary voice effect ended");
    this.owned.delete(channelId);
    console.info(`event=scenario.voice.channel match=${this.token} channel=${channelId} status=removed`);
    return true;
  }

  receipt(event: string, change: VoiceChange): void {
    console.info(`event=scenario.voice.change match=${this.token} member=${change.memberId} operation=${change.operation} original=${change.originalChannel} destination=${change.destination ?? "none"} status=${event}`);
  }
}
