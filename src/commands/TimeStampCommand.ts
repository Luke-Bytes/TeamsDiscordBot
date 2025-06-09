import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Command } from "./CommandInterface.js";
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { DiscordUtil } from "../util/DiscordUtil";

export default class TimestampCommand implements Command {
  name = "timestamp";
  description = "Convert a date/time to a Discord timestamp";
  buttonIds: string[] = [];

  data = new SlashCommandBuilder()
    .setName(this.name)
    .setDescription(this.description)
    .addStringOption((option) =>
      option
        .setName("time")
        .setDescription("Date/time (e.g 'tomorrow 7pm')")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("timezone")
        .setDescription("Timezone (e.g 'GMT', 'JST')")
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("format")
        .setDescription("Display format")
        .addChoices(
          { name: "Date & Time", value: "F" },
          { name: "Countdown", value: "R" },
          { name: "Time Only", value: "t" },
          { name: "Date Only", value: "D" }
        )
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName("echo")
        .setDescription("Echo the timestamp in a plain message")
        .setRequired(false)
    );

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const input = interaction.options.getString("time", true);
    const tz = interaction.options.getString("timezone") ?? "UTC";
    const format = interaction.options.getString("format") ?? "F";
    const echo = interaction.options.getBoolean("echo") ?? true;

    const parsed = chrono.parseDate(input, new Date(), { forwardDate: true });
    if (!parsed) {
      await interaction.reply({
        content: "❌ Could not parse the date/time input.",
        ephemeral: false,
      });
      return;
    }

    const dt = DateTime.fromObject(
      {
        year: parsed.getFullYear(),
        month: parsed.getMonth() + 1,
        day: parsed.getDate(),
        hour: parsed.getHours(),
        minute: parsed.getMinutes(),
        second: parsed.getSeconds(),
      },
      { zone: tz }
    );

    if (!dt.isValid) {
      await interaction.reply({
        content: `❌ Invalid timezone: ${tz}`,
        ephemeral: false,
      });
      return;
    }

    const unix = Math.floor(dt.toSeconds());
    const discordTimestamp = `<t:${unix}:${format}>`;

    await interaction.reply({
      content: `**🕒 Converted Timestamp:**\n${discordTimestamp}`,
      ephemeral: false,
    });

    if (echo) {
      if (interaction.guild) {
        const channelKey = DiscordUtil.getChannelKeyById(interaction.channelId);
        if (channelKey) {
          await DiscordUtil.sendMessage(
            channelKey,
            `\`\`\`${discordTimestamp}\`\`\``
          );
        }
      } else {
        await interaction.user.send(`\`\`\`${discordTimestamp}\`\`\``);
      }
    }
  }
}
