import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { Command } from "./CommandInterface.js";
import { DiscordUtil } from "../util/DiscordUtil.js";
import { PermissionsUtil } from "../util/PermissionsUtil.js";
import { verifyIGN } from "../logic/VerifyIGN";

export default class VerifyCommand implements Command {
  public data = new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verify Minecraft IGNs against the database")
    .addSubcommand((sub) =>
      sub
        .setName("igns")
        .setDescription("Validate usernames")
        .addStringOption((opt) =>
          opt
            .setName("names")
            .setDescription("Space separated list of usernames to verify")
            .setRequired(true)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("pingplayers")
            .setDescription("Whether to ping verified players")
            .setRequired(false)
        )
    );

  public name = this.data.name;
  public description = this.data.description;
  public buttonIds: string[] = [];

  public async execute(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const member = DiscordUtil.getGuildMember(interaction);
    if (!member || !PermissionsUtil.hasRole(member, "organiserRole")) {
      await DiscordUtil.reply(
        interaction,
        "🚫 You do not have permission to use this command. Only organisers may use it."
      );
      return;
    }

    await interaction.deferReply();
    const namesInput = interaction.options.getString("names", true);
    const ping = interaction.options.getBoolean("pingplayers") ?? false;
    const allNames = namesInput.split(/\s+/).filter((n) => n.length > 0);
    const names = [...new Map(allNames.map((name) => [name.toLowerCase(), name])).values()];
    if (names.length > 25) {
      await interaction.editReply("Please verify no more than 25 distinct names per request.");
      return;
    }
    if (names.some((name) => name.length > 16)) {
      await interaction.editReply("Minecraft usernames must be no longer than 16 characters.");
      return;
    }

    const results: string[] = [];
    const mentionableUserIds: string[] = [];

    for (const name of names) {
      results.push(
        ...(await verifyIGN(name, interaction.guild, ping, mentionableUserIds))
      );
    }

    const header = "**Verification Results**:\n\n";
    const lines: string[] = [];
    let length = header.length;
    for (const result of results) {
      if (length + result.length + 1 > 1800) {
        lines.push("… Additional results omitted to stay within Discord's message limit.");
        break;
      }
      lines.push(result);
      length += result.length + 1;
    }
    await interaction.editReply({
      content: header + lines.join("\n"),
      allowedMentions: { parse: [], users: [...new Set(mentionableUserIds)] },
    });
  }


}
