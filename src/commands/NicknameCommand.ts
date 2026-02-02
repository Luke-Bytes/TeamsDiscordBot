import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface";
import { DiscordUtil } from "../util/DiscordUtil";
import { PermissionsUtil } from "../util/PermissionsUtil";
import { PrismaUtils } from "../util/PrismaUtils";
import { escapeText } from "../util/Utils";

export default class NicknameCommand implements Command {
  public name = "nickname";
  public description = "Set or clear a server nickname based on latest IGN";
  public buttonIds: string[] = [];

  public data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Set to latest IGN or clear nickname")
        .setRequired(true)
        .addChoices(
          { name: "ign", value: "ign" },
          { name: "clear", value: "clear" }
        )
    )
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Target user (organisers only)")
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

    const member = DiscordUtil.getGuildMember(interaction);
    const isOrganiser = PermissionsUtil.hasRole(member, "organiserRole");
    const targetUser = interaction.options.getUser("user") ?? interaction.user;

    if (targetUser.id !== interaction.user.id && !isOrganiser) {
      await DiscordUtil.reply(
        interaction,
        "Only organisers can set nicknames for other users."
      );
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const targetMember = await interaction.guild.members
      .fetch(targetUser.id)
      .catch(() => null);
    if (!targetMember) {
      await interaction.editReply("Could not find that guild member.");
      return;
    }

    const action = interaction.options.getString("action", true);
    if (action === "clear") {
      try {
        await targetMember.setNickname(null);
        await interaction.editReply(
          `Cleared nickname for ${escapeText(targetUser.tag)}.`
        );
      } catch (error) {
        console.error("Failed to clear nickname:", error);
        await interaction.editReply(
          "Failed to clear nickname. Check bot permissions."
        );
      }
      return;
    }

    const player = await PrismaUtils.findPlayer(targetUser.id);
    if (!player || !player.latestIGN) {
      await interaction.editReply(
        "No latest IGN found for that user in the database."
      );
      return;
    }

    const safeIgn = escapeText(player.latestIGN);
    try {
      await targetMember.setNickname(player.latestIGN);
      await interaction.editReply(
        `Set nickname for ${escapeText(targetUser.tag)} to **${safeIgn}**.`
      );
    } catch (error) {
      console.error("Failed to set nickname:", error);
      await interaction.editReply(
        "Failed to set nickname. Check bot permissions."
      );
    }
  }
}
