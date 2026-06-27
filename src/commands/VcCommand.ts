import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Command } from "./CommandInterface";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { DiscordUtil } from "../util/DiscordUtil";
import {
  TempVoiceChannelManager,
  TemporaryVoiceChannelRecord,
} from "../logic/TempVoiceChannelManager";
import { PrismaUtils } from "../util/PrismaUtils";

type ResolvedUsers = {
  userIds: string[];
  unresolved: string[];
};

const CHANNEL_NAME_MAX = 100;

export default class VcCommand implements Command {
  public name = "vc";
  public description = "Create and manage your temporary voice channel";
  public buttonIds: string[] = [];

  public constructor(public readonly manager = new TempVoiceChannelManager()) {}

  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Create a temporary voice channel")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Voice channel name")
            .setRequired(true)
        )
        .addIntegerOption((option) =>
          option
            .setName("user-limit")
            .setDescription("Maximum users allowed in the channel")
            .setMinValue(0)
            .setMaxValue(99)
        )
        .addIntegerOption((option) =>
          option
            .setName("auto-lock-minutes")
            .setDescription("Automatically lock after this many minutes")
            .setMinValue(1)
            .setMaxValue(720)
        )
        .addBooleanOption((option) =>
          option
            .setName("private")
            .setDescription("Only invited users can connect at first")
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("delete")
        .setDescription("Delete your temporary voice channel")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Owner to target, organisers only")
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("lock").setDescription("Lock your temporary VC")
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("unlock").setDescription("Unlock your temporary VC")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Invite users by mention, Discord ID, or latest IGN")
        .addStringOption((option) =>
          option
            .setName("users")
            .setDescription("Space-separated users")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove users from your temporary VC")
        .addStringOption((option) =>
          option
            .setName("users")
            .setDescription("Space-separated users")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("limit")
        .setDescription("Update your temporary VC user limit")
        .addIntegerOption((option) =>
          option
            .setName("user-limit")
            .setDescription("Maximum users allowed in the channel")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(99)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("info")
        .setDescription("Show temporary VC details")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Owner to inspect, organisers only")
        )
    );

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!PermissionsUtil.isChannel(interaction, "botCommands")) {
      await this.reply(
        interaction,
        "This command can only be used in the bot commands channel."
      );
      return;
    }

    if (!interaction.inGuild() || !interaction.guild) {
      await this.reply(
        interaction,
        "This command can only be used in a server."
      );
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === "create") {
      await this.create(interaction);
      return;
    }

    if (subcommand === "delete") {
      await this.delete(interaction);
      return;
    }

    if (subcommand === "info") {
      await this.info(interaction);
      return;
    }

    const record = await this.requireOwnedRecord(interaction);
    if (!record) return;

    if (subcommand === "lock") {
      await this.manager.lock(record, interaction.guild);
      await this.reply(interaction, `Locked <#${record.channelId}>.`);
      return;
    }

    if (subcommand === "unlock") {
      await this.manager.unlock(record, interaction.guild);
      await this.reply(interaction, `Unlocked <#${record.channelId}>.`);
      return;
    }

    if (subcommand === "add") {
      await this.add(interaction, record);
      return;
    }

    if (subcommand === "remove") {
      await this.remove(interaction, record);
      return;
    }

    if (subcommand === "limit") {
      const userLimit = interaction.options.getInteger("user-limit", true);
      await this.manager.setUserLimit(record, interaction.guild, userLimit);
      await this.reply(
        interaction,
        `Updated <#${record.channelId}> user limit.`
      );
    }
  }

  private async create(interaction: ChatInputCommandInteraction) {
    const rawName = interaction.options.getString("name", true);
    const normalizedName = this.normalizeChannelName(rawName);
    if (!normalizedName) {
      await this.reply(
        interaction,
        "Use a channel name with at least one letter or number."
      );
      return;
    }
    if (normalizedName.length > CHANNEL_NAME_MAX) {
      await this.reply(
        interaction,
        `Channel names must be ${CHANNEL_NAME_MAX} characters or fewer.`
      );
      return;
    }

    const result = await this.manager.create({
      guild: interaction.guild!,
      ownerId: interaction.user.id,
      name: normalizedName,
      userLimit: interaction.options.getInteger("user-limit"),
      autoLockMinutes: interaction.options.getInteger("auto-lock-minutes"),
      private: interaction.options.getBoolean("private") ?? false,
    });

    if (!result.ok && result.reason === "exists") {
      await this.reply(
        interaction,
        `You already own <#${result.record.channelId}>. Delete it before creating another.`
      );
      return;
    }

    if (!result.ok && result.reason === "missing_category") {
      await this.reply(
        interaction,
        "Temporary voice channels are not configured yet."
      );
      return;
    }

    await this.reply(
      interaction,
      `Created <#${result.channel.id}>. It expires ${this.discordTimestamp(
        result.record.expiresAt
      )}.`
    );
  }

  private async delete(interaction: ChatInputCommandInteraction) {
    const targetOwnerId = await this.getTargetOwnerId(interaction);
    if (!targetOwnerId) return;

    const deleted = await this.manager.deleteForOwner(
      interaction.guild!,
      targetOwnerId
    );
    if (!deleted) {
      await this.reply(interaction, "No temporary voice channel was found.");
      return;
    }

    await this.reply(interaction, `Deleted temporary VC "${deleted.name}".`);
  }

  private async info(interaction: ChatInputCommandInteraction) {
    const targetOwnerId = await this.getTargetOwnerId(interaction);
    if (!targetOwnerId) return;

    const record = await this.manager.findByOwner(
      interaction.guild!.id,
      targetOwnerId
    );
    if (!record) {
      await this.reply(interaction, "No temporary voice channel was found.");
      return;
    }

    const channel = await this.manager.getVoiceChannel(
      interaction.guild!,
      record
    );
    const limit = channel?.userLimit ? String(channel.userLimit) : "None";
    await this.reply(
      interaction,
      [
        `Channel: <#${record.channelId}>`,
        `Owner: <@${record.ownerId}>`,
        `Locked: ${record.locked ? "Yes" : "No"}`,
        `Limit: ${limit}`,
        `Invited: ${record.invitedUserIds.length}`,
        `Expires: ${this.discordTimestamp(record.expiresAt)}`,
      ].join("\n")
    );
  }

  private async add(
    interaction: ChatInputCommandInteraction,
    record: TemporaryVoiceChannelRecord
  ) {
    const resolved = await this.resolveUsers(
      interaction.options.getString("users", true)
    );
    if (resolved.userIds.length > 0) {
      await this.manager.addUsers(record, interaction.guild!, resolved.userIds);
    }

    await this.reply(interaction, this.formatBulkResult("Added", resolved));
  }

  private async remove(
    interaction: ChatInputCommandInteraction,
    record: TemporaryVoiceChannelRecord
  ) {
    const resolved = await this.resolveUsers(
      interaction.options.getString("users", true)
    );
    let disconnected: string[] = [];
    if (resolved.userIds.length > 0) {
      const result = await this.manager.removeUsers(
        record,
        interaction.guild!,
        resolved.userIds
      );
      disconnected = result.disconnected;
    }

    const lines = [this.formatBulkResult("Removed", resolved)];
    if (disconnected.length > 0) {
      lines.push(
        `Disconnected: ${disconnected.map((id) => `<@${id}>`).join(", ")}`
      );
    }
    await this.reply(interaction, lines.join("\n"));
  }

  private async requireOwnedRecord(
    interaction: ChatInputCommandInteraction
  ): Promise<TemporaryVoiceChannelRecord | null> {
    const record = await this.manager.findByOwner(
      interaction.guild!.id,
      interaction.user.id
    );
    if (!record) {
      await this.reply(
        interaction,
        "You do not own a temporary voice channel."
      );
      return null;
    }
    return record;
  }

  private async getTargetOwnerId(
    interaction: ChatInputCommandInteraction
  ): Promise<string | null> {
    const targetUser = interaction.options.getUser("user");
    const targetOwnerId = targetUser?.id ?? interaction.user.id;
    if (targetOwnerId === interaction.user.id) return targetOwnerId;

    const member = interaction.member as GuildMember | null;
    if (!PermissionsUtil.hasRole(member ?? undefined, "organiserRole")) {
      await this.reply(
        interaction,
        "Only organisers can target another user's temporary VC."
      );
      return null;
    }
    return targetOwnerId;
  }

  private async resolveUsers(input: string): Promise<ResolvedUsers> {
    const userIds: string[] = [];
    const unresolved: string[] = [];
    const tokens = input
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    for (const token of tokens) {
      const mentionMatch = token.match(/^<@!?(\d{17,19})>$/);
      const directId = mentionMatch?.[1] ?? token;
      if (DiscordUtil.isValidSnowflake(directId)) {
        userIds.push(directId);
        continue;
      }

      const player = await PrismaUtils.findPlayer(token);
      if (player?.discordSnowflake) {
        userIds.push(player.discordSnowflake);
      } else {
        unresolved.push(token);
      }
    }

    return { userIds: Array.from(new Set(userIds)), unresolved };
  }

  private formatBulkResult(action: string, resolved: ResolvedUsers): string {
    const lines: string[] = [];
    if (resolved.userIds.length > 0) {
      lines.push(
        `${action}: ${resolved.userIds.map((id) => `<@${id}>`).join(", ")}`
      );
    }
    if (resolved.unresolved.length > 0) {
      lines.push(`Unresolved: ${resolved.unresolved.join(", ")}`);
    }
    return lines.length > 0 ? lines.join("\n") : "No users were resolved.";
  }

  private normalizeChannelName(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9 -]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  private discordTimestamp(date: Date): string {
    return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
  }

  private async reply(
    interaction: ChatInputCommandInteraction,
    content: string
  ) {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
