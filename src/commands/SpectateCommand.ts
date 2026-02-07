import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { DiscordUtil } from "../util/DiscordUtil";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { ConfigManager } from "../ConfigManager";
import { escapeText } from "../util/Utils";

type PendingRequest = {
  requestId: string;
  requesterId: string;
  targetId: string;
  expiresAt: number;
};

type ActiveSpectate = {
  targetId: string;
  channelId: string;
  expiresAt: number;
};

const REQUEST_TTL_MS = 15 * 60 * 1000;
const REJOIN_TTL_MS = 60 * 60 * 1000;

export default class SpectateCommand implements Command {
  public name = "spectate";
  public description = "Request or manage spectating";
  public buttonIds: string[] = ["spectate-accept:", "spectate-deny:"];

  private pendingRequests = new Map<string, PendingRequest>();
  private activeSpectates = new Map<string, ActiveSpectate>();

  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Spectate action")
        .setRequired(true)
        .addChoices(
          { name: "request", value: "request" },
          { name: "allow", value: "allow" },
          { name: "rejoin", value: "rejoin" },
          { name: "stop", value: "stop" }
        )
    )
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Target user for request/allow")
        .setRequired(false)
    );

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) {
      await DiscordUtil.reply(
        interaction,
        "This command can only be used in a server."
      );
      return;
    }

    this.cleanupExpired();
    const action = interaction.options.getString("action", true);
    const targetUser = interaction.options.getUser("user");

    if (action === "request") {
      await this.handleRequest(interaction, targetUser?.id ?? null);
      return;
    }

    if (action === "allow") {
      await this.handleAllow(interaction, targetUser?.id ?? null);
      return;
    }

    if (action === "rejoin") {
      await this.handleRejoin(interaction);
      return;
    }

    if (action === "stop") {
      await this.handleStop(interaction);
      return;
    }
  }

  public async handleButtonPress(
    interaction: ButtonInteraction
  ): Promise<void> {
    this.cleanupExpired();
    const id = interaction.customId;
    if (id.startsWith("spectate-accept:")) {
      const requestId = id.split(":")[1];
      await this.handleAccept(interaction, requestId);
      return;
    }
    if (id.startsWith("spectate-deny:")) {
      const requestId = id.split(":")[1];
      await this.handleDeny(interaction, requestId);
    }
  }

  private cleanupExpired() {
    const now = Date.now();
    for (const [key, request] of this.pendingRequests) {
      if (request.expiresAt <= now) {
        this.pendingRequests.delete(key);
      }
    }
    for (const [key, active] of this.activeSpectates) {
      if (active.expiresAt <= now) {
        this.activeSpectates.delete(key);
      }
    }
  }

  private isCaptainOrClanLeader(member: GuildMember | null): boolean {
    if (!member) return false;
    return (
      PermissionsUtil.hasRole(member, "captainRole") ||
      PermissionsUtil.hasRole(member, "clanLeaderRole")
    );
  }

  private getMemberVoiceChannelId(member: GuildMember | null): string | null {
    return member?.voice?.channel?.id ?? null;
  }

  private createRequestId(requesterId: string, targetId: string): string {
    return `${requesterId}:${targetId}:${Date.now()}`;
  }

  private async handleRequest(
    interaction: ChatInputCommandInteraction,
    targetId: string | null
  ): Promise<void> {
    if (!targetId) {
      await DiscordUtil.reply(
        interaction,
        "You must mention a captain or clan leader to request spectating."
      );
      return;
    }

    const guild = interaction.guild!;
    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (!targetMember || !this.isCaptainOrClanLeader(targetMember)) {
      await DiscordUtil.reply(
        interaction,
        "That user is not a captain or clan leader."
      );
      return;
    }

    const targetChannelId = this.getMemberVoiceChannelId(targetMember);
    if (!targetChannelId) {
      await DiscordUtil.reply(
        interaction,
        "That captain/clan leader must be in a voice channel to request spectating."
      );
      return;
    }

    const requestId = this.createRequestId(interaction.user.id, targetId);
    this.pendingRequests.set(requestId, {
      requestId,
      requesterId: interaction.user.id,
      targetId,
      expiresAt: Date.now() + REQUEST_TTL_MS,
    });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`spectate-accept:${requestId}`)
        .setLabel("Yes")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`spectate-deny:${requestId}`)
        .setLabel("No")
        .setStyle(ButtonStyle.Danger)
    );

    const requesterTag = escapeText(interaction.user.tag);
    const dmContent = `Spectate request from **${requesterTag}**. Allow them to spectate your voice channel?`;

    const dmSent = await targetMember.user
      .send({ content: dmContent, components: [row] })
      .then(() => true)
      .catch(() => false);

    if (!dmSent) {
      await DiscordUtil.reply(
        interaction,
        "Couldn't DM the captain/clan leader. Ask them to use `/spectate allow @user`.",
        true
      );
      return;
    }

    await DiscordUtil.reply(
      interaction,
      `Sent a spectate request to ${escapeText(targetMember.user.tag)}.`,
      true
    );
  }

  private async handleAllow(
    interaction: ChatInputCommandInteraction,
    requesterId: string | null
  ): Promise<void> {
    if (!requesterId) {
      await DiscordUtil.reply(
        interaction,
        "You must mention the user who requested spectating."
      );
      return;
    }

    const guild = interaction.guild!;
    const authorMember = await guild.members
      .fetch(interaction.user.id)
      .catch(() => null);

    if (!this.isCaptainOrClanLeader(authorMember)) {
      await DiscordUtil.reply(
        interaction,
        "Only captains or clan leaders can allow spectating."
      );
      return;
    }

    const pending = this.findPendingRequest(requesterId, interaction.user.id);
    if (!pending) {
      await DiscordUtil.reply(
        interaction,
        "No pending spectate request found for that user."
      );
      return;
    }

    await this.acceptRequest(interaction, pending);
  }

  private async handleAccept(
    interaction: ButtonInteraction,
    requestId: string
  ): Promise<void> {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      await interaction.reply({
        content: "This spectate request has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: "This action must be run in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== pending.targetId) {
      await interaction.reply({
        content: "Only the requested captain/clan leader can accept.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await this.acceptRequest(interaction, pending);
  }

  private async handleDeny(
    interaction: ButtonInteraction,
    requestId: string
  ): Promise<void> {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      await interaction.reply({
        content: "This spectate request has expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.user.id !== pending.targetId) {
      await interaction.reply({
        content: "Only the requested captain/clan leader can deny.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    this.pendingRequests.delete(requestId);
    await interaction.reply({
      content: "Spectate request denied.",
      flags: MessageFlags.Ephemeral,
    });
  }

  private async acceptRequest(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    pending: PendingRequest
  ): Promise<void> {
    const guild = interaction.guild!;
    const targetMember = await guild.members
      .fetch(pending.targetId)
      .catch(() => null);
    if (!targetMember || !this.isCaptainOrClanLeader(targetMember)) {
      await interaction.reply({
        content: "Captain/clan leader is not available anymore.",
        flags: MessageFlags.Ephemeral,
      });
      this.pendingRequests.delete(pending.requestId);
      return;
    }

    const targetChannelId = this.getMemberVoiceChannelId(targetMember);
    if (!targetChannelId) {
      await interaction.reply({
        content:
          "You must be in a voice channel to allow spectating for your channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const requesterMember = await guild.members
      .fetch(pending.requesterId)
      .catch(() => null);
    if (!requesterMember) {
      await interaction.reply({
        content: "Requester no longer exists in this server.",
        flags: MessageFlags.Ephemeral,
      });
      this.pendingRequests.delete(pending.requestId);
      return;
    }

    if (!requesterMember.voice?.channel?.id) {
      await interaction.reply({
        content:
          "Requester must join any voice channel and run `/spectate rejoin`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const spectatorRoleId = ConfigManager.getConfig().roles.spectatorRole;
    await DiscordUtil.assignRole(requesterMember, spectatorRoleId);
    await requesterMember.voice.setMute(true).catch(() => {});
    await requesterMember.voice.setDeaf(true).catch(() => {});
    await requesterMember.voice.setChannel(targetChannelId).catch(() => {});

    this.pendingRequests.delete(pending.requestId);
    this.activeSpectates.set(pending.requesterId, {
      targetId: pending.targetId,
      channelId: targetChannelId,
      expiresAt: Date.now() + REJOIN_TTL_MS,
    });

    await interaction.reply({
      content: "Spectate request accepted and user moved.",
      flags: MessageFlags.Ephemeral,
    });
  }

  private findPendingRequest(
    requesterId: string,
    targetId: string
  ): PendingRequest | null {
    for (const request of this.pendingRequests.values()) {
      if (
        request.requesterId === requesterId &&
        request.targetId === targetId &&
        request.expiresAt > Date.now()
      ) {
        return request;
      }
    }
    return null;
  }

  private async handleRejoin(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const guild = interaction.guild!;
    const requesterId = interaction.user.id;
    const active = this.activeSpectates.get(requesterId);
    if (!active || active.expiresAt <= Date.now()) {
      await DiscordUtil.reply(
        interaction,
        "No active spectate session found (or it expired)."
      );
      this.activeSpectates.delete(requesterId);
      return;
    }

    const member = await guild.members.fetch(requesterId).catch(() => null);
    if (!member || !member.voice?.channel?.id) {
      await DiscordUtil.reply(
        interaction,
        "Join any voice channel first, then run `/spectate rejoin`."
      );
      return;
    }

    const spectatorRoleId = ConfigManager.getConfig().roles.spectatorRole;
    await DiscordUtil.assignRole(member, spectatorRoleId);
    await member.voice.setMute(true).catch(() => {});
    await member.voice.setDeaf(true).catch(() => {});
    await member.voice.setChannel(active.channelId).catch(() => {});

    await DiscordUtil.reply(
      interaction,
      "Rejoined your spectate channel.",
      true
    );
  }

  private async handleStop(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const guild = interaction.guild!;
    const member = await guild.members
      .fetch(interaction.user.id)
      .catch(() => null);
    if (!member || !member.voice?.channel?.id) {
      await DiscordUtil.reply(
        interaction,
        "Join a voice channel and then use `/spectate stop`."
      );
      return;
    }

    const spectatorRoleId = ConfigManager.getConfig().roles.spectatorRole;
    if (!member.roles.cache.has(spectatorRoleId)) {
      await DiscordUtil.reply(
        interaction,
        "You do not have the spectator role."
      );
      return;
    }

    await member.voice.setMute(false).catch(() => {});
    await member.voice.setDeaf(false).catch(() => {});
    await DiscordUtil.removeRole(member, spectatorRoleId);
    this.activeSpectates.delete(interaction.user.id);

    await DiscordUtil.reply(interaction, "Spectating stopped.", true);
  }
}
